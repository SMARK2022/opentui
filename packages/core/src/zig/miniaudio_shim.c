#define MINIAUDIO_IMPLEMENTATION

#if defined(__linux__)
#define MA_ENABLE_ONLY_SPECIFIC_BACKENDS
#define MA_ENABLE_ALSA
#define MA_ENABLE_PULSEAUDIO
#endif

#if defined(__APPLE__)
#define MA_ENABLE_ONLY_SPECIFIC_BACKENDS
#define MA_ENABLE_COREAUDIO
#endif

#if defined(_WIN32)
#define MA_ENABLE_ONLY_SPECIFIC_BACKENDS
#define MA_ENABLE_WASAPI
#define MA_ENABLE_DSOUND
#define MA_ENABLE_WINMM
#endif

#if defined(__linux__)
#include <dlfcn.h>
#include <stddef.h>

// ALSA 诊断静默:libasound 默认 error handler 直写 stderr,在无声卡但装有
// libasound 的机器(headless 服务器/SSH 登录节点)上,每次 default PCM 解析链
// 失败都会刷屏。官方 snd_lib_error_set_handler 是标准接管点(alsamixer/CRAS 同款)。
typedef void (*snd_error_handler_t)(const char *file, int line, const char *func, int err, const char *fmt, ...);
typedef int (*snd_error_set_handler_fn)(snd_error_handler_t handler);

// 纯 no-op:签名与 snd_error_handler_t 精确一致但忽略全部实参。libasound 可能从
// 任意线程(含 miniaudio 音频线程)调 handler,只做 return 满足并发契约;
// 函数体随本 .so 存续且永不即载,不触发 PortAudio 式悬垂回调 segfault。
static void opentui_asound_silence(const char *file, int line, const char *func, int err, const char *fmt, ...) {
    (void)file;
    (void)line;
    (void)func;
    (void)err;
    (void)fmt;
}

// constructor 在 .so 装载时执行,严格早于 miniaudio 首次 dlopen libasound:
// 同一 libasound 实例(refcount)上的 handler 对进程内全部 ALSA 交互生效。
// dlopen 而非构建期链接:不引入 libasound 构建依赖;句柄永不 close——
// 若 dlclose 后 miniaudio 重新 dlopen,会得到带默认 handler 的新实例,噪声回归。
__attribute__((constructor)) static void opentui_install_asound_silence(void) {
    void *handle = dlopen("libasound.so.2", RTLD_LAZY);
    if (handle == NULL) handle = dlopen("libasound.so", RTLD_LAZY);
    if (handle == NULL) return; /* 无 libasound 则无诊断可静默 */
    snd_error_set_handler_fn set = (snd_error_set_handler_fn)dlsym(handle, "snd_lib_error_set_handler");
    if (set != NULL) set(&opentui_asound_silence);
}
#endif

#include "vendor/miniaudio/miniaudio.h"
