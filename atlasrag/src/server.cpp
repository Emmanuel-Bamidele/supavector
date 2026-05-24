// -----------------------------------------
// Tell Asio we are using standalone version
// (not Boost.Asio)
// -----------------------------------------
#define ASIO_STANDALONE

#include <asio.hpp>      // Networking library (TCP sockets)
#include <atomic>        // std::atomic
#include <chrono>        // time utilities
#include <cstdlib>       // std::strtof (string -> float)
#include <iostream>      // std::cout, std::cerr
#include <mutex>         // std::mutex, std::lock_guard
#include <sstream>       // std::istringstream
#include <string>        // std::string
#include <thread>        // std::thread
#include <utility>       // std::pair
#include <vector>        // std::vector

#include "db.h"          // string KV database (TTL, etc.)
#include "wal.h"         // write-ahead log
#include "vector_db.h"   // NEW: vector store for embeddings

// Short alias: tcp refers to asio::ip::tcp
using asio::ip::tcp;

////////////////////////////////////////////////////////////
// Split a string into words by spaces
// Example: "SET a 10" -> ["SET","a","10"]
////////////////////////////////////////////////////////////
static std::vector<std::string> split_words(const std::string& line)
{
  std::vector<std::string> parts;

  // Treat the string as an input stream
  std::istringstream iss(line);

  std::string word;

  // "while (iss >> word)" extracts words separated by whitespace
  while (iss >> word) {
    parts.push_back(word);
  }

  return parts;
}

////////////////////////////////////////////////////////////
// Convert tokens parts[start..] into a vector<float>
// We expect exactly "dim" floats.
// Returns empty vector if parse fails.
////////////////////////////////////////////////////////////
static std::vector<float> parse_floats(
    const std::vector<std::string>& parts,
    std::size_t start,
    int dim)
{
  std::vector<float> out;

  // dim must be positive
  if (dim <= 0) return {};

  // Check we have enough tokens
  // Example: parts = ["VSEARCH","5","1536", f1, f2, ...]
  // floats begin at "start"
  if (parts.size() < start + (std::size_t)dim) return {};

  out.reserve((std::size_t)dim);

  for (int i = 0; i < dim; ++i) {

    // Convert string -> float safely
    const std::string& s = parts[start + (std::size_t)i];

    // std::strtof reads C-string; endptr points to where parsing stopped
    char* endptr = nullptr;
    float v = std::strtof(s.c_str(), &endptr);

    // If parsing failed, endptr == s.c_str()
    if (endptr == s.c_str()) return {};

    out.push_back(v);
  }

  return out;
}

////////////////////////////////////////////////////////////
// Serialize the current vector state into WAL VSET format.
////////////////////////////////////////////////////////////
static std::string build_vset_wal_line(
    const std::string& id,
    const std::vector<float>& vec)
{
  std::string wal_line = "VSET " + id + " " + std::to_string(vec.size());
  for (float x : vec) {
    wal_line += " " + std::to_string(x);
  }
  return wal_line;
}

////////////////////////////////////////////////////////////
// Build a full WAL snapshot from the in-memory DBs.
////////////////////////////////////////////////////////////
static std::vector<std::string> build_wal_snapshot(DB& db, const VectorDB& vdb)
{
  auto kv_entries = db.snapshot();
  auto vector_entries = vdb.snapshot();

  std::vector<std::string> lines;
  lines.reserve(kv_entries.size() + vector_entries.size());

  for (const auto& entry : kv_entries) {
    std::string line = "SET " + entry.key + " " + entry.value;
    if (entry.ttl_seconds) {
      line += " EX " + std::to_string(*entry.ttl_seconds);
    }
    lines.push_back(line);
  }

  for (const auto& entry : vector_entries) {
    lines.push_back(build_vset_wal_line(entry.first, entry.second));
  }

  return lines;
}

////////////////////////////////////////////////////////////
// Rewrite the WAL from the current in-memory state.
// If compaction fails, fall back to appending the latest mutation line.
////////////////////////////////////////////////////////////
static void compact_wal(
    DB& db,
    WAL& wal,
    const VectorDB& vdb,
    const std::string& fallback_line)
{
  if (!wal.rewrite_lines(build_wal_snapshot(db, vdb))) {
    wal.append_line(fallback_line);
  }
}

////////////////////////////////////////////////////////////
// METRICS (atomic counters are safe across threads)
////////////////////////////////////////////////////////////
static std::atomic<long long> g_total_connections{0};     // total accepted since start
static std::atomic<long long> g_active_connections{0};    // currently connected
static std::atomic<long long> g_commands_processed{0};    // all non-empty commands
static std::atomic<long long> g_set_count{0};             // SET commands
static std::atomic<long long> g_get_count{0};             // GET commands
static std::atomic<long long> g_del_count{0};             // DEL commands

// NEW vector command counters
static std::atomic<long long> g_vset_count{0};            // VSET commands
static std::atomic<long long> g_vdel_count{0};            // VDEL commands
static std::atomic<long long> g_vdel_prefix_count{0};     // VDELPREFIX commands
static std::atomic<long long> g_vclear_count{0};          // VCLEAR commands
static std::atomic<long long> g_vsearch_count{0};         // VSEARCH commands
static std::atomic<long long> g_vsearch_ann_count{0};     // VSEARCHANN commands

// Controls whether vector operations are written to WAL.
// Default is off for the OSS profile; set VECTOR_WAL=1 to enable durability.
static bool g_vector_wal_enabled = false;

// Serialize mutating commands that change in-memory state and the WAL.
// This keeps snapshot rewrites from racing with concurrent writers.
static std::mutex g_mutation_mu;

// Start time for uptime calculation
static auto g_start_time = std::chrono::steady_clock::now();

////////////////////////////////////////////////////////////
// Handle one command and return reply
////////////////////////////////////////////////////////////
static std::string handle_command(
    const std::string& line,
    DB& db,
    WAL& wal,
    VectorDB& vdb)              // NEW: vector db passed in
{
  auto parts = split_words(line);

  // Empty command -> ignore
  if (parts.empty())
    return "";

  // Count all non-empty commands
  g_commands_processed.fetch_add(1);

  // First word is the command name
  const std::string& cmd = parts[0];

  // --------------------------------
  // PING (simple health check)
  // --------------------------------
  if (cmd == "PING" && parts.size() == 1) {
    return "PONG\n";
  }

  // --------------------------------
  // STATS (returns JSON)
  // --------------------------------
  if (cmd == "STATS" && parts.size() == 1) {

    // uptime = seconds since program start
    auto now = std::chrono::steady_clock::now();
    auto uptime_sec =
      std::chrono::duration_cast<std::chrono::seconds>(now - g_start_time).count();

    // Build JSON string manually
    std::string json = "{";
    json += "\"uptime_seconds\":" + std::to_string(uptime_sec) + ",";
    json += "\"total_connections\":" + std::to_string(g_total_connections.load()) + ",";
    json += "\"active_connections\":" + std::to_string(g_active_connections.load()) + ",";
    json += "\"commands_processed\":" + std::to_string(g_commands_processed.load()) + ",";
    json += "\"set_count\":" + std::to_string(g_set_count.load()) + ",";
    json += "\"get_count\":" + std::to_string(g_get_count.load()) + ",";
    json += "\"del_count\":" + std::to_string(g_del_count.load()) + ",";
    json += "\"keys\":" + std::to_string(db.size()) + ",";
    json += "\"expired_removed\":" + std::to_string(db.expired_removed_count()) + ",";

    // NEW: vector stats
    json += "\"vectors\":" + std::to_string(vdb.size()) + ",";
    json += "\"vector_dims\":" + std::to_string(vdb.dims()) + ",";
    json += "\"vset_count\":" + std::to_string(g_vset_count.load()) + ",";
    json += "\"vdel_count\":" + std::to_string(g_vdel_count.load()) + ",";
    json += "\"vdel_prefix_count\":" + std::to_string(g_vdel_prefix_count.load()) + ",";
    json += "\"vclear_count\":" + std::to_string(g_vclear_count.load()) + ",";
    json += "\"vsearch_count\":" + std::to_string(g_vsearch_count.load()) + ",";
    json += "\"vsearch_ann_count\":" + std::to_string(g_vsearch_ann_count.load()) + ",";
    json += "\"ann_index_ready\":" + std::string(vdb.ann_index_size() == vdb.size() && vdb.size() > 0 ? "true" : "false") + ",";
    json += "\"ann_index_vectors\":" + std::to_string(vdb.ann_index_size()) + ",";
    json += "\"ann_bucket_count\":" + std::to_string(vdb.ann_bucket_count()) + ",";
    json += "\"ann_table_count\":" + std::to_string(vdb.ann_table_count()) + ",";
    json += "\"ann_bits_per_table\":" + std::to_string(vdb.ann_bits_per_table());

    json += "}";

    return json + "\n";
  }

  // ========================================================
  // STRING KV COMMANDS (core KV layer)
  // ========================================================

  // --------------------------------
  // SET key value
  // --------------------------------
  if (cmd == "SET" && parts.size() == 3) {

    g_set_count.fetch_add(1);

    const std::string& key = parts[1];
    const std::string& val = parts[2];

    std::lock_guard<std::mutex> mutation_guard(g_mutation_mu);

    // Save to disk first (WAL)
    wal.append_line("SET " + key + " " + val);

    // Save in memory
    db.set(key, val);

    return "OK\n";
  }

  // --------------------------------
  // SET key value EX seconds
  // --------------------------------
  if (cmd == "SET" && parts.size() == 5 && parts[3] == "EX") {

    g_set_count.fetch_add(1);

    const std::string& key = parts[1];
    const std::string& val = parts[2];

    // Convert string -> int
    int ttl = std::stoi(parts[4]);

    std::lock_guard<std::mutex> mutation_guard(g_mutation_mu);

    wal.append_line("SET " + key + " " + val + " EX " + parts[4]);

    db.set_with_ttl(key, val, ttl);

    return "OK\n";
  }

  // --------------------------------
  // GET key
  // --------------------------------
  if (cmd == "GET" && parts.size() == 2) {

    g_get_count.fetch_add(1);

    const std::string& key = parts[1];

    auto v = db.get(key);

    if (v) return *v + "\n";

    return "(nil)\n";
  }

  // --------------------------------
  // DEL key
  // --------------------------------
  if (cmd == "DEL" && parts.size() == 2) {

    g_del_count.fetch_add(1);

    const std::string& key = parts[1];

    std::lock_guard<std::mutex> mutation_guard(g_mutation_mu);

    wal.append_line("DEL " + key);

    bool removed = db.del(key);

    return removed ? "1\n" : "0\n";
  }

  // ========================================================
  // VECTOR COMMANDS (NEW: GenAI semantic search backend)
  // ========================================================

  // --------------------------------
  // VSET id dim f1 f2 ... f_dim
  //
  // Example (dim=3):
  // VSET doc1#0 3 0.1 0.2 0.3
  // --------------------------------
  if (cmd == "VSET" && parts.size() >= 4) {

    g_vset_count.fetch_add(1);

    const std::string& id = parts[1];

    int dim = std::stoi(parts[2]);

    // floats start at index 3
    std::vector<float> vec = parse_floats(parts, 3, dim);

    if (vec.empty()) {
      return "ERR bad vector\n";
    }

    std::lock_guard<std::mutex> mutation_guard(g_mutation_mu);

    // Optional: keep dimensions consistent after first insert
    // VectorDB itself enforces "one dims" behavior by storing dims_
    VectorDB::UpsertResult upsert_result = vdb.add_or_update(id, vec);
    if (upsert_result == VectorDB::UpsertResult::InvalidVector) {
      return "ERR bad vector\n";
    }
    if (upsert_result == VectorDB::UpsertResult::DimensionMismatch) {
      return "ERR vector dimension mismatch\n";
    }

    if (g_vector_wal_enabled) {
      wal.append_line(build_vset_wal_line(id, vec));
    }

    return upsert_result == VectorDB::UpsertResult::Inserted ? "OK new\n" : "OK updated\n";
  }

  // --------------------------------
  // VDEL id
  // --------------------------------
  if (cmd == "VDEL" && parts.size() == 2) {

    g_vdel_count.fetch_add(1);

    const std::string& id = parts[1];

    std::lock_guard<std::mutex> mutation_guard(g_mutation_mu);

    bool removed = vdb.remove(id);

    if (g_vector_wal_enabled) {
      if (removed && vdb.size() == 0) {
        compact_wal(db, wal, vdb, "VDEL " + id);
      } else {
        wal.append_line("VDEL " + id);
      }
    }

    return removed ? "1\n" : "0\n";
  }

  // --------------------------------
  // VDELPREFIX prefix
  // --------------------------------
  if (cmd == "VDELPREFIX" && parts.size() == 2) {

    g_vdel_prefix_count.fetch_add(1);

    const std::string& prefix = parts[1];

    std::lock_guard<std::mutex> mutation_guard(g_mutation_mu);

    std::size_t removed = vdb.remove_prefix(prefix);

    if (g_vector_wal_enabled) {
      if (removed > 0) {
        compact_wal(db, wal, vdb, "VDELPREFIX " + prefix);
      } else {
        wal.append_line("VDELPREFIX " + prefix);
      }
    }

    return std::to_string(removed) + "\n";
  }

  // --------------------------------
  // VCLEAR
  // --------------------------------
  if (cmd == "VCLEAR" && parts.size() == 1) {

    g_vclear_count.fetch_add(1);

    std::lock_guard<std::mutex> mutation_guard(g_mutation_mu);

    vdb.clear();

    if (g_vector_wal_enabled) {
      compact_wal(db, wal, vdb, "VCLEAR");
    }

    return "OK\n";
  }

  // --------------------------------
  // VSEARCH k dim q1 q2 ... q_dim
  //
  // Example:
  // VSEARCH 5 3 0.2 0.1 0.4
  //
  // Reply format (one line):
  // id1 score1|id2 score2|...
  // --------------------------------
  if (cmd == "VSEARCH" && parts.size() >= 4) {

    g_vsearch_count.fetch_add(1);

    int k = std::stoi(parts[1]);
    int dim = std::stoi(parts[2]);

    std::vector<float> q = parse_floats(parts, 3, dim);
    if (q.empty()) return "ERR bad query vector\n";

    auto results = vdb.search(q, k);

    // Build a simple one-line response
    // Example: "doc#0 0.87|doc#3 0.82\n"
    std::string out;

    for (std::size_t i = 0; i < results.size(); ++i) {
      out += results[i].first;
      out += " ";
      out += std::to_string(results[i].second);

      if (i + 1 < results.size())
        out += "|";
    }

    out += "\n";
    return out;
  }

  // --------------------------------
  // VSEARCHIN k dim q1 ... q_dim count id1 id2 ... id_count
  //
  // Searches only the provided vector ids.
  // --------------------------------
  if (cmd == "VSEARCHIN" && parts.size() >= 5) {

    g_vsearch_count.fetch_add(1);

    int k = std::stoi(parts[1]);
    int dim = std::stoi(parts[2]);

    std::vector<float> q = parse_floats(parts, 3, dim);
    if (q.empty()) return "ERR bad query vector\n";

    std::size_t count_idx = 3 + (std::size_t)dim;
    if (parts.size() <= count_idx) return "ERR missing id count\n";

    int id_count = std::stoi(parts[count_idx]);
    if (id_count < 0) return "ERR bad id count\n";

    std::size_t ids_start = count_idx + 1;
    if (parts.size() < ids_start + (std::size_t)id_count) {
      return "ERR insufficient ids\n";
    }

    std::vector<std::string> ids;
    ids.reserve((std::size_t)id_count);
    for (int i = 0; i < id_count; ++i) {
      ids.push_back(parts[ids_start + (std::size_t)i]);
    }

    auto results = vdb.search_subset(q, k, ids);

    std::string out;
    for (std::size_t i = 0; i < results.size(); ++i) {
      out += results[i].first;
      out += " ";
      out += std::to_string(results[i].second);

      if (i + 1 < results.size())
        out += "|";
    }

    out += "\n";
    return out;
  }

  // --------------------------------
  // VSEARCHANN k dim q1 ... q_dim overfetch
  //
  // Uses the approximate side index to generate candidates, then exact-rescores
  // those candidates before returning top-k.
  // --------------------------------
  if (cmd == "VSEARCHANN" && parts.size() >= 5) {

    g_vsearch_ann_count.fetch_add(1);

    int k = std::stoi(parts[1]);
    int dim = std::stoi(parts[2]);

    std::vector<float> q = parse_floats(parts, 3, dim);
    if (q.empty()) return "ERR bad query vector\n";

    std::size_t overfetch_idx = 3 + (std::size_t)dim;
    int overfetch = 5;
    if (parts.size() > overfetch_idx) {
      overfetch = std::stoi(parts[overfetch_idx]);
    }

    auto results = vdb.search_ann(q, k, overfetch);

    std::string out;
    for (std::size_t i = 0; i < results.size(); ++i) {
      out += results[i].first;
      out += " ";
      out += std::to_string(results[i].second);

      if (i + 1 < results.size())
        out += "|";
    }

    out += "\n";
    return out;
  }

  // --------------------------------
  // VSEARCHANNIN k dim q1 ... q_dim overfetch count id1 id2 ... id_count
  //
  // Approximate candidate generation constrained to an allowed id set, followed
  // by exact rescoring of the approximate candidates.
  // --------------------------------
  if (cmd == "VSEARCHANNIN" && parts.size() >= 6) {

    g_vsearch_ann_count.fetch_add(1);

    int k = std::stoi(parts[1]);
    int dim = std::stoi(parts[2]);

    std::vector<float> q = parse_floats(parts, 3, dim);
    if (q.empty()) return "ERR bad query vector\n";

    std::size_t overfetch_idx = 3 + (std::size_t)dim;
    if (parts.size() <= overfetch_idx) return "ERR missing overfetch\n";

    int overfetch = std::stoi(parts[overfetch_idx]);
    std::size_t count_idx = overfetch_idx + 1;
    if (parts.size() <= count_idx) return "ERR missing id count\n";

    int id_count = std::stoi(parts[count_idx]);
    if (id_count < 0) return "ERR bad id count\n";

    std::size_t ids_start = count_idx + 1;
    if (parts.size() < ids_start + (std::size_t)id_count) {
      return "ERR insufficient ids\n";
    }

    std::vector<std::string> ids;
    ids.reserve((std::size_t)id_count);
    for (int i = 0; i < id_count; ++i) {
      ids.push_back(parts[ids_start + (std::size_t)i]);
    }

    auto results = vdb.search_ann_subset(q, k, overfetch, ids);

    std::string out;
    for (std::size_t i = 0; i < results.size(); ++i) {
      out += results[i].first;
      out += " ";
      out += std::to_string(results[i].second);

      if (i + 1 < results.size())
        out += "|";
    }

    out += "\n";
    return out;
  }

  return "ERR unknown command\n";
}

////////////////////////////////////////////////////////////
// Load WAL file into DB on startup (replay)
////////////////////////////////////////////////////////////
static void replay_wal(DB& db, const WAL& wal, VectorDB& vdb)
{
  wal.for_each_line([&db, &vdb](const std::string& line) {

    auto parts = split_words(line);
    if (parts.empty()) return;

    // STRING SET
    if (parts.size() == 3 && parts[0] == "SET") {
      db.set(parts[1], parts[2]);
      return;
    }

    // STRING SET with TTL
    if (parts.size() == 5 && parts[0] == "SET" && parts[3] == "EX") {
      int ttl = std::stoi(parts[4]);
      db.set_with_ttl(parts[1], parts[2], ttl);
      return;
    }

    // STRING DEL
    if (parts.size() == 2 && parts[0] == "DEL") {
      db.del(parts[1]);
      return;
    }

    // VECTOR VCLEAR
    if (parts.size() == 1 && parts[0] == "VCLEAR") {
      vdb.clear();
      return;
    }

    // VECTOR VDEL
    if (parts.size() == 2 && parts[0] == "VDEL") {
      vdb.remove(parts[1]);
      return;
    }

    // VECTOR VDELPREFIX
    if (parts.size() == 2 && parts[0] == "VDELPREFIX") {
      vdb.remove_prefix(parts[1]);
      return;
    }

    // VECTOR VSET
    // VSET id dim f1 f2 ... f_dim
    if (parts.size() >= 4 && parts[0] == "VSET") {

      const std::string& id = parts[1];
      int dim = std::stoi(parts[2]);

      std::vector<float> vec = parse_floats(parts, 3, dim);
      if (!vec.empty()) {
        vdb.add_or_update(id, vec);
      }
      return;
    }

    // Unknown WAL line: ignore (safe for MVP)
  });
}

////////////////////////////////////////////////////////////
// Background thread that deletes expired keys (TTL)
////////////////////////////////////////////////////////////
void ttl_cleanup_thread(DB& db)
{
  while (true) {

    // Sleep for 1 second
    std::this_thread::sleep_for(std::chrono::seconds(1));

    // Remove expired keys
    {
      std::lock_guard<std::mutex> mutation_guard(g_mutation_mu);
      db.cleanup_expired();
    }
  }
}

////////////////////////////////////////////////////////////
// One client connection runs in its own thread
////////////////////////////////////////////////////////////
static void client_thread(
    tcp::socket socket,
    DB& db,
    WAL& wal,
    VectorDB& vdb)   // NEW: vector db shared by all clients
{
  try {
    // Keep one buffer per connection so read_until() can preserve any bytes
    // it read past the first newline. Recreating the buffer each loop drops
    // pipelined commands and breaks batched TCP writes.
    asio::streambuf buffer;

    while (true) {

      // Wait until client sends newline
      asio::read_until(socket, buffer, "\n");

      std::istream is(&buffer);
      std::string line;

      std::getline(is, line);

      // Remove '\r' (Windows telnet style)
      if (!line.empty() && line.back() == '\r')
        line.pop_back();

      // Ignore blank lines
      if (line.empty())
        continue;

      std::string reply = handle_command(line, db, wal, vdb);

      if (!reply.empty()) {
        asio::write(socket, asio::buffer(reply));
      }
    }
  }
  catch (...) {
    // client disconnected
  }

  // When client thread exits, connection is no longer active
  g_active_connections.fetch_sub(1);
}

////////////////////////////////////////////////////////////
// Program entry point
////////////////////////////////////////////////////////////
int main()
{
  DB db;                 // string KV store
  VectorDB vdb;          // NEW: vector store
  const char* wal_path_env = std::getenv("WAL_PATH");
  const std::string wal_path =
      (wal_path_env && std::string(wal_path_env).size())
          ? std::string(wal_path_env)
          : "wal.log";
  WAL wal(wal_path);     // durability log file

  // VECTOR_WAL=1 enables vector WAL; default is off.
  const char* vector_wal_env = std::getenv("VECTOR_WAL");
  if (vector_wal_env && std::string(vector_wal_env) == "1") {
    g_vector_wal_enabled = true;
  }

  // Load previous data from wal.log
  replay_wal(db, wal, vdb);

  // Start TTL cleanup thread (for string KV TTL)
  std::thread(ttl_cleanup_thread, std::ref(db)).detach();

  asio::io_context io;

  // Listen on port 6379
  tcp::acceptor acceptor(
      io,
      tcp::endpoint(tcp::v4(), 6379));

  std::cout << "AtlasRAG listening on port 6379...\n";

  // Accept clients forever
  while (true) {

    tcp::socket socket(io);

    // Wait for a client to connect
    acceptor.accept(socket);

    // Metrics: total and active connections
    g_total_connections.fetch_add(1);
    g_active_connections.fetch_add(1);

    std::cout << "Client connected\n";

    // Start a new thread for the client
    std::thread(
      client_thread,
      std::move(socket), // move = transfer ownership of socket
      std::ref(db),      // ref = pass by reference
      std::ref(wal),
      std::ref(vdb)
    ).detach();
  }
}
