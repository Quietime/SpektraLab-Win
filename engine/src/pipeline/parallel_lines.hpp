// Independent scan lines: preserve each line's accumulation order while
// bounding host worker count. No process-wide thread pool; Android reads one
// startup worker hint set by its host before rendering begins.
#pragma once
#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <thread>
#include <utility>
#include <vector>

namespace spk {
#ifdef __ANDROID__
inline uint32_t android_default_line_worker_limit() {
    static const uint32_t limit = [] {
        const uint32_t cores = std::thread::hardware_concurrency();
        const uint32_t safe = std::min(8u, cores > 1 ? cores - 1 : 1u);
        const char* hint = std::getenv("SPEKTRALAB_CPU_WORKERS");
        if (!hint || !*hint) return safe;
        uint32_t requested = 0;
        for (const char* p = hint; *p; ++p) {
            if (*p < '0' || *p > '9') return safe;
            requested = requested * 10 + uint32_t(*p - '0');
            if (requested > 8) return safe;
        }
        return requested ? std::min(requested, safe) : safe;
    }();
    return limit;
}
#endif
template <class F>
void portable_for_each_line(uint32_t lines, F&& fn, uint32_t worker_limit = 0) {
    if (!lines) return;
#ifdef __ANDROID__
    const uint32_t limit = worker_limit ? worker_limit : android_default_line_worker_limit();
#else
    const uint32_t limit = worker_limit ? worker_limit :
        std::min(8u, std::max(1u, std::thread::hardware_concurrency()));
#endif
    const uint32_t workers = std::min(lines, limit);
    auto run = [&](uint32_t worker) {
        for (uint32_t line = worker; line < lines; line += workers) fn(line);
    };
#ifdef __ANDROID__
    // NDK 27 libc++ has no jthread. Keep identical ownership/join semantics.
    struct JoiningThread : std::thread {
        using std::thread::thread;
        JoiningThread(JoiningThread&&) = default;
        ~JoiningThread() { if (joinable()) join(); }
    };
    std::vector<JoiningThread> threads;
#else
    std::vector<std::jthread> threads;
#endif
    threads.reserve(workers - 1);
    for (uint32_t worker = 1; worker < workers; ++worker) threads.emplace_back(run, worker);
    run(0);
    // jthread joins before the caller can consume the completed output.
}
}  // namespace spk
