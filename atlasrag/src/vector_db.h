//
//  vector_db.h
//  AtlasRAG
//
//  Created by Emmanuel Bamidele on 2/11/26.
//

#pragma once
// ^ "pragma once" prevents this header from being included multiple times in one build.

// -------------------------
// C++ standard library includes
// -------------------------
#include <algorithm>      // std::partial_sort, std::min
#include <cctype>         // std::tolower
#include <cmath>          // std::sqrt
#include <cstdint>        // std::uint64_t
#include <cstdlib>        // std::getenv
#include <random>         // std::mt19937, std::normal_distribution
#include <shared_mutex>   // std::shared_mutex, std::unique_lock, std::shared_lock
#include <string>         // std::string
#include <unordered_map>  // std::unordered_map
#include <unordered_set>  // std::unordered_set
#include <utility>        // std::pair
#include <vector>         // std::vector

// VectorDB = in-memory store for embeddings (vector<float>).
// It supports:
//  - add/update an embedding by id
//  - delete an embedding
//  - search top-k most similar vectors to a query vector (cosine similarity)
class VectorDB {
public:
  enum class UpsertResult {
    Inserted,
    Updated,
    InvalidVector,
    DimensionMismatch
  };

  // Constructor: create an empty VectorDB
  VectorDB() = default;

  // -------------------------
  // add_or_update(id, vec)
  // -------------------------
  // "void" means this returns nothing.
  // "const std::string&" = reference to a string that we promise not to modify (fast: no copy).
  // "const std::vector<float>&" = reference to vector of floats (embedding), no copy.
  //
  // Returns whether the vector was inserted, updated, or rejected.
  UpsertResult add_or_update(const std::string& id,
                             const std::vector<float>& vec)
  {
    // unique_lock = exclusive lock (only one writer at a time).
    std::unique_lock lock(mu_);
    if (vec.empty()) return UpsertResult::InvalidVector;
    if (dims_ != 0 && (int)vec.size() != dims_) return UpsertResult::DimensionMismatch;
    ensure_ann_index_locked((int)vec.size());

    // find existing id
    auto it = vectors_.find(id);

    // If not found, insert new
    if (it == vectors_.end()) {
      vectors_[id] = vec;   // copy vec into the map
      dims_ = (int)vec.size(); // remember the embedding dimension we are using
      add_to_ann_locked(id, vec);
      return UpsertResult::Inserted;
    }

    // If found, update existing
    remove_from_ann_locked(id, it->second);
    it->second = vec; // replace the stored vector
    add_to_ann_locked(id, vec);
    return UpsertResult::Updated;
  }

  // -------------------------
  // remove(id)
  // -------------------------
  // Returns: true if removed, false if id didn't exist.
  bool remove(const std::string& id)
  {
    std::unique_lock lock(mu_);

    // erase returns number of items erased (0 or 1)
    auto it = vectors_.find(id);
    if (it == vectors_.end()) return false;
    remove_from_ann_locked(id, it->second);
    bool removed = vectors_.erase(id) > 0;
    if (removed && vectors_.empty()) {
      dims_ = 0;
      reset_ann_locked();
    }
    return removed;
  }

  // -------------------------
  // remove_prefix(prefix)
  // -------------------------
  // Removes every vector whose id starts with the provided prefix.
  // Returns the number of removed vectors.
  std::size_t remove_prefix(const std::string& prefix)
  {
    std::unique_lock lock(mu_);

    if (prefix.empty() || vectors_.empty()) return 0;

    std::size_t removed = 0;
    for (auto it = vectors_.begin(); it != vectors_.end();) {
      if (it->first.rfind(prefix, 0) == 0) {
        remove_from_ann_locked(it->first, it->second);
        it = vectors_.erase(it);
        removed += 1;
      } else {
        ++it;
      }
    }

    if (vectors_.empty()) {
      dims_ = 0;
      reset_ann_locked();
    }
    return removed;
  }

  // -------------------------
  // clear()
  // -------------------------
  void clear()
  {
    std::unique_lock lock(mu_);
    vectors_.clear();
    dims_ = 0;
    reset_ann_locked();
  }

  // Return a full copy of the current vector state for WAL compaction.
  std::vector<std::pair<std::string, std::vector<float>>> snapshot() const
  {
    std::shared_lock lock(mu_);

    std::vector<std::pair<std::string, std::vector<float>>> entries;
    entries.reserve(vectors_.size());

    for (const auto& item : vectors_) {
      entries.push_back(item);
    }

    return entries;
  }

  // -------------------------
  // size()
  // -------------------------
  // "std::size_t" is an unsigned integer type used for sizes.
  std::size_t size() const
  {
    // shared_lock = multiple readers can access at same time.
    std::shared_lock lock(mu_);
    return vectors_.size();
  }

  // -------------------------
  // dims()
  // -------------------------
  // returns the embedding dimension we are using (e.g. 1536).
  // returns 0 if empty (no vectors stored yet).
  int dims() const
  {
    std::shared_lock lock(mu_);
    return dims_;
  }

  std::size_t ann_index_size() const
  {
    std::shared_lock lock(mu_);
    return ann_index_size_;
  }

  std::size_t ann_bucket_count() const
  {
    std::shared_lock lock(mu_);
    std::size_t count = 0;
    for (const auto& table : ann_tables_) {
      count += table.size();
    }
    return count;
  }

  int ann_table_count() const
  {
    std::shared_lock lock(mu_);
    return ann_table_count_;
  }

  int ann_bits_per_table() const
  {
    std::shared_lock lock(mu_);
    return ann_bits_per_table_;
  }

  // -------------------------
  // search(query, k)
  // -------------------------
  // query = embedding vector for the query text
  // k = number of results you want (top-k)
  //
  // Returns a vector of (id, score) pairs sorted by score descending.
  // score is cosine similarity (range approx -1..1).
  std::vector<std::pair<std::string, float>>
  search(const std::vector<float>& query, int k) const
  {
    std::shared_lock lock(mu_);

    // If empty database, return empty list
    if (vectors_.empty()) return {};

    // If query dimension doesn't match stored dimension, return empty
    // (We enforce "one dimension for all vectors" in MVP.)
    if ((int)query.size() != dims_) return {};

    // Precompute query norm (length)
    float qnorm = norm(query);
    if (qnorm == 0.0f) return {}; // avoid divide-by-zero

    // We'll compute similarity for every vector (brute-force scan).
    // This is fine for MVP (hundreds/thousands of vectors).
    std::vector<std::pair<std::string, float>> scores;
    scores.reserve(vectors_.size());

    // range-based for loop: "for (const auto& item : vectors_)"
    // "const auto&" means:
    //  - const: we won't modify item
    //  - auto: compiler figures out the type
    //  - &: reference to avoid copying
    for (const auto& item : vectors_) {

      const std::string& id = item.first;          // map key
      const std::vector<float>& vec = item.second; // map value
      if (vec.size() != query.size()) {
        continue;
      }

      float vnorm = norm(vec);
      if (vnorm == 0.0f) {
        // if vector has 0 length, similarity is 0
        scores.push_back({id, 0.0f});
        continue;
      }

      // cosine similarity = dot(query, vec) / (|query| * |vec|)
      float sim = dot(query, vec) / (qnorm * vnorm);

      scores.push_back({id, sim});
    }

    // If k is larger than size, reduce it
    if (k < 0) k = 0;
    if ((std::size_t)k > scores.size()) k = (int)scores.size();

    // partial_sort puts the top-k items in front in correct order,
    // without sorting the entire array (faster than full sort).
    std::partial_sort(
      scores.begin(),
      scores.begin() + k,
      scores.end(),
      [](const auto& a, const auto& b) {
        return a.second > b.second; // higher similarity first
      }
    );

    // resize to only keep top-k
    scores.resize(k);

    return scores;
  }

  // -------------------------
  // search_subset(query, k, ids)
  // -------------------------
  // Similar to search(), but only evaluates vectors whose ids are in "ids".
  std::vector<std::pair<std::string, float>>
  search_subset(const std::vector<float>& query, int k, const std::vector<std::string>& ids) const
  {
    std::shared_lock lock(mu_);

    if (vectors_.empty()) return {};
    if (ids.empty()) return {};
    if ((int)query.size() != dims_) return {};

    float qnorm = norm(query);
    if (qnorm == 0.0f) return {};

    std::vector<std::pair<std::string, float>> scores;
    scores.reserve(ids.size());

    for (const auto& id : ids) {
      auto it = vectors_.find(id);
      if (it == vectors_.end()) continue;

      const std::vector<float>& vec = it->second;
      if (vec.size() != query.size()) {
        continue;
      }
      float vnorm = norm(vec);
      if (vnorm == 0.0f) {
        scores.push_back({id, 0.0f});
        continue;
      }
      float sim = dot(query, vec) / (qnorm * vnorm);
      scores.push_back({id, sim});
    }

    if (scores.empty()) return {};

    if (k < 0) k = 0;
    if ((std::size_t)k > scores.size()) k = (int)scores.size();

    std::partial_sort(
      scores.begin(),
      scores.begin() + k,
      scores.end(),
      [](const auto& a, const auto& b) {
        return a.second > b.second;
      }
    );

    scores.resize(k);
    return scores;
  }

  // Approximate nearest-neighbor search using deterministic random-projection
  // LSH as candidate generation, followed by exact cosine rescoring.
  std::vector<std::pair<std::string, float>>
  search_ann(const std::vector<float>& query, int k, int overfetch) const
  {
    std::shared_lock lock(mu_);

    if (vectors_.empty()) return {};
    if ((int)query.size() != dims_) return {};
    if (ann_tables_.empty() || ann_index_size_ == 0) return {};

    float qnorm = norm(query);
    if (qnorm == 0.0f) return {};

    const int clean_overfetch = overfetch > 0 ? overfetch : 5;
    const int candidate_limit = std::max(k, k * clean_overfetch);
    std::unordered_set<std::string> seen;
    std::vector<std::string> candidate_ids;
    candidate_ids.reserve((std::size_t)std::max(candidate_limit, k));

    for (int table_index = 0; table_index < (int)ann_tables_.size(); ++table_index) {
      const std::uint64_t signature = ann_signature_locked(query, table_index);
      auto bucket = ann_tables_[table_index].find(signature);
      if (bucket == ann_tables_[table_index].end()) continue;
      for (const auto& id : bucket->second) {
        if (seen.insert(id).second) {
          candidate_ids.push_back(id);
          if ((int)candidate_ids.size() >= candidate_limit) break;
        }
      }
      if ((int)candidate_ids.size() >= candidate_limit) break;
    }

    if (candidate_ids.empty()) return {};

    std::vector<std::pair<std::string, float>> scores;
    scores.reserve(candidate_ids.size());
    for (const auto& id : candidate_ids) {
      auto it = vectors_.find(id);
      if (it == vectors_.end()) continue;
      const auto& vec = it->second;
      if (vec.size() != query.size()) continue;
      float vnorm = norm(vec);
      float sim = vnorm == 0.0f ? 0.0f : dot(query, vec) / (qnorm * vnorm);
      scores.push_back({id, sim});
    }

    if (scores.empty()) return {};
    if (k < 0) k = 0;
    if ((std::size_t)k > scores.size()) k = (int)scores.size();

    std::partial_sort(
      scores.begin(),
      scores.begin() + k,
      scores.end(),
      [](const auto& a, const auto& b) {
        return a.second > b.second;
      }
    );

    scores.resize(k);
    return scores;
  }

  std::vector<std::pair<std::string, float>>
  search_ann_subset(const std::vector<float>& query, int k, int overfetch, const std::vector<std::string>& ids) const
  {
    std::shared_lock lock(mu_);

    if (vectors_.empty()) return {};
    if (ids.empty()) return {};
    if ((int)query.size() != dims_) return {};
    if (ann_tables_.empty() || ann_index_size_ == 0) return {};

    float qnorm = norm(query);
    if (qnorm == 0.0f) return {};

    std::unordered_set<std::string> allowed(ids.begin(), ids.end());
    const int clean_overfetch = overfetch > 0 ? overfetch : 5;
    const int candidate_limit = std::max(k, k * clean_overfetch);
    std::unordered_set<std::string> seen;
    std::vector<std::string> candidate_ids;
    candidate_ids.reserve((std::size_t)std::max(candidate_limit, k));

    for (int table_index = 0; table_index < (int)ann_tables_.size(); ++table_index) {
      const std::uint64_t signature = ann_signature_locked(query, table_index);
      auto bucket = ann_tables_[table_index].find(signature);
      if (bucket == ann_tables_[table_index].end()) continue;
      for (const auto& id : bucket->second) {
        if (allowed.find(id) == allowed.end()) continue;
        if (seen.insert(id).second) {
          candidate_ids.push_back(id);
          if ((int)candidate_ids.size() >= candidate_limit) break;
        }
      }
      if ((int)candidate_ids.size() >= candidate_limit) break;
    }

    if (candidate_ids.empty()) return {};

    std::vector<std::pair<std::string, float>> scores;
    scores.reserve(candidate_ids.size());
    for (const auto& id : candidate_ids) {
      auto it = vectors_.find(id);
      if (it == vectors_.end()) continue;
      const auto& vec = it->second;
      if (vec.size() != query.size()) continue;
      float vnorm = norm(vec);
      float sim = vnorm == 0.0f ? 0.0f : dot(query, vec) / (qnorm * vnorm);
      scores.push_back({id, sim});
    }

    if (scores.empty()) return {};
    if (k < 0) k = 0;
    if ((std::size_t)k > scores.size()) k = (int)scores.size();

    std::partial_sort(
      scores.begin(),
      scores.begin() + k,
      scores.end(),
      [](const auto& a, const auto& b) {
        return a.second > b.second;
      }
    );

    scores.resize(k);
    return scores;
  }

private:
  // -------------------------
  // dot(a, b)
  // -------------------------
  // dot product = sum(a[i] * b[i])
  static float dot(const std::vector<float>& a,
                   const std::vector<float>& b)
  {
    float s = 0.0f;

    // for loop: i from 0 to a.size()-1
    for (std::size_t i = 0; i < a.size(); ++i) {
      s += a[i] * b[i];
    }
    return s;
  }

  // -------------------------
  // norm(v)
  // -------------------------
  // norm = sqrt(sum(v[i]^2))
  static float norm(const std::vector<float>& v)
  {
    float s = 0.0f;

    for (float x : v) {
      s += x * x;
    }

    return std::sqrt(s);
  }

  static int env_int(const char* name, int fallback, int min_value, int max_value)
  {
    const char* raw = std::getenv(name);
    if (!raw) return fallback;
    int value = std::atoi(raw);
    if (value < min_value) return fallback;
    if (value > max_value) return max_value;
    return value;
  }

  static bool env_bool(const char* name, bool fallback)
  {
    const char* raw = std::getenv(name);
    if (!raw) return fallback;
    std::string value(raw);
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
      return (char)std::tolower(c);
    });
    if (value == "1" || value == "true" || value == "yes" || value == "on") return true;
    if (value == "0" || value == "false" || value == "no" || value == "off") return false;
    return fallback;
  }

  void ensure_ann_index_locked(int dim)
  {
    if (dim <= 0 || !ann_planes_.empty()) return;
    if (!env_bool("VECTOR_ANN_ENABLED", false)) return;
    ann_table_count_ = env_int("VECTOR_ANN_LSH_TABLES", 8, 1, 32);
    ann_bits_per_table_ = env_int("VECTOR_ANN_LSH_BITS", 12, 1, 63);
    ann_planes_.resize((std::size_t)ann_table_count_);

    std::mt19937 rng(1337);
    std::normal_distribution<float> dist(0.0f, 1.0f);
    for (int table = 0; table < ann_table_count_; ++table) {
      ann_planes_[table].resize((std::size_t)ann_bits_per_table_);
      for (int bit = 0; bit < ann_bits_per_table_; ++bit) {
        auto& plane = ann_planes_[table][bit];
        plane.resize((std::size_t)dim);
        for (int i = 0; i < dim; ++i) {
          plane[(std::size_t)i] = dist(rng);
        }
      }
    }
    ann_tables_.resize((std::size_t)ann_table_count_);
  }

  void reset_ann_locked()
  {
    ann_planes_.clear();
    ann_tables_.clear();
    ann_index_size_ = 0;
  }

  std::uint64_t ann_signature_locked(const std::vector<float>& vec, int table_index) const
  {
    std::uint64_t signature = 0;
    const auto& planes = ann_planes_[(std::size_t)table_index];
    for (int bit = 0; bit < (int)planes.size(); ++bit) {
      const auto& plane = planes[(std::size_t)bit];
      float projection = 0.0f;
      for (std::size_t i = 0; i < vec.size(); ++i) {
        projection += vec[i] * plane[i];
      }
      if (projection >= 0.0f) {
        signature |= (std::uint64_t{1} << (std::uint64_t)bit);
      }
    }
    return signature;
  }

  void add_to_ann_locked(const std::string& id, const std::vector<float>& vec)
  {
    if (ann_tables_.empty()) return;
    for (int table_index = 0; table_index < (int)ann_tables_.size(); ++table_index) {
      const std::uint64_t signature = ann_signature_locked(vec, table_index);
      ann_tables_[(std::size_t)table_index][signature].push_back(id);
    }
    ann_index_size_ += 1;
  }

  void remove_from_ann_locked(const std::string& id, const std::vector<float>& vec)
  {
    if (ann_tables_.empty()) return;
    for (int table_index = 0; table_index < (int)ann_tables_.size(); ++table_index) {
      const std::uint64_t signature = ann_signature_locked(vec, table_index);
      auto bucket = ann_tables_[(std::size_t)table_index].find(signature);
      if (bucket == ann_tables_[(std::size_t)table_index].end()) continue;
      auto& ids = bucket->second;
      ids.erase(std::remove(ids.begin(), ids.end(), id), ids.end());
      if (ids.empty()) {
        ann_tables_[(std::size_t)table_index].erase(bucket);
      }
    }
    if (ann_index_size_ > 0) ann_index_size_ -= 1;
  }

  // Mutex for thread safety.
  // "mutable" allows locking inside const functions like size() and search().
  mutable std::shared_mutex mu_;

  // The actual storage: id -> embedding vector
  std::unordered_map<std::string, std::vector<float>> vectors_;

  // Store the expected dimension (e.g. 1536).
  // We keep MVP simple: all vectors must have same dimension.
  int dims_ = 0;

  int ann_table_count_ = 8;
  int ann_bits_per_table_ = 12;
  std::size_t ann_index_size_ = 0;
  std::vector<std::vector<std::vector<float>>> ann_planes_;
  std::vector<std::unordered_map<std::uint64_t, std::vector<std::string>>> ann_tables_;
};
