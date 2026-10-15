#pragma once
// Prevent multiple inclusion

#include <cstdio>    // std::remove, std::rename
#include <fcntl.h>   // open
#include <fstream>   // file input/output
#include <unistd.h>  // fsync, close
#include <mutex>     // std::mutex, std::lock_guard
#include <string>    // std::string
#include <vector>    // std::vector

// WAL = Write-Ahead Log
// Stores every change so data survives crashes
class WAL {

public:

  // Constructor
  // explicit prevents accidental conversions
  explicit WAL(const std::string& path)
      : path_(path) {}   // store filename

  // Append one command line to log file
  void append_line(const std::string& line) {

    // lock_guard locks mutex when created,
    // and unlocks automatically when function exits
    std::lock_guard<std::mutex> guard(mu_);

    // Open file in append mode
    std::ofstream out(path_, std::ios::app);

    if (!out.is_open()) return;

    out << line << "\n";   // write command
    out.flush();             // hand to the OS; sync_file() makes it durable
  }

  // Flush the log's written bytes from the OS cache to disk. flush() alone
  // survives a process crash but not a host crash or power loss. fsync works
  // on the file, whichever descriptor wrote it, so writers are never blocked.
  bool sync_file() const {
    return sync_path(path_);
  }

  // Stream WAL file one line at a time.
  // This avoids loading very large WAL files into memory all at once.
  template <typename Fn>
  void for_each_line(Fn&& fn) const {
    std::lock_guard<std::mutex> guard(mu_);

    std::ifstream in(path_);
    if (!in.is_open()) return;

    std::string line;
    while (std::getline(in, line)) {
      if (!line.empty()) {
        fn(line);
      }
    }
  }

  // Read entire WAL file
  std::vector<std::string> read_all_lines() const {

    std::vector<std::string> lines;

    for_each_line([&lines](const std::string& line) {
      lines.push_back(line);
    });

    return lines;
  }

  // Rewrite the WAL from scratch using the provided snapshot lines.
  // The rewrite uses a temporary file and then atomically swaps it in.
  bool rewrite_lines(const std::vector<std::string>& lines) {
    std::lock_guard<std::mutex> guard(mu_);

    const std::string tmp_path = path_ + ".tmp";

    {
      std::ofstream out(tmp_path, std::ios::trunc);
      if (!out.is_open()) return false;

      for (const auto& line : lines) {
        out << line << "\n";
      }
      out.flush();

      if (!out.good()) {
        out.close();
        std::remove(tmp_path.c_str());
        return false;
      }
    }

    // The snapshot must be on disk before it replaces the log, and the
    // rename must be on disk before the old log's contents are gone.
    if (!sync_path(tmp_path)) {
      std::remove(tmp_path.c_str());
      return false;
    }

    if (std::rename(tmp_path.c_str(), path_.c_str()) != 0) {
      std::remove(tmp_path.c_str());
      return false;
    }

    const std::string::size_type slash = path_.find_last_of('/');
    sync_path(slash == std::string::npos ? std::string(".") : path_.substr(0, slash == 0 ? 1 : slash));
    return true;
  }

private:

  static bool sync_path(const std::string& path) {
    const int fd = ::open(path.c_str(), O_RDONLY);
    if (fd < 0) return false;
    const bool ok = ::fsync(fd) == 0;
    ::close(fd);
    return ok;
  }

  std::string path_;   // filename of WAL

  // Protects file writes from multiple threads
  mutable std::mutex mu_;
};
