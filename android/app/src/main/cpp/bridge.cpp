#include <jni.h>
#include <node.h>
#include <node_api.h>
#include <android/log.h>
#include <unistd.h>
#include <string>
#include <vector>
#include <cstdlib>
#include <cstring>

static JavaVM* vm = nullptr;
static jobject storage = nullptr;
static jmethodID call_method = nullptr;

extern "C" JNIEXPORT jint JNI_OnLoad(JavaVM* v, void*) { vm = v; return JNI_VERSION_1_6; }

static napi_value Call(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc != 2 || !storage) { napi_throw_error(env, "EIO", "Android storage is not initialized"); return nullptr; }
    std::vector<std::u16string> args;
    for (size_t i = 0; i < argc; ++i) {
        size_t len = 0;
        napi_get_value_string_utf16(env, argv[i], nullptr, 0, &len);
        std::vector<char16_t> buf(len + 1);
        napi_get_value_string_utf16(env, argv[i], buf.data(), buf.size(), &len);
        args.emplace_back(buf.data(), len);
    }
    JNIEnv* jni;
    bool attached = vm->GetEnv(reinterpret_cast<void**>(&jni), JNI_VERSION_1_6) != JNI_OK;
    if (attached) vm->AttachCurrentThread(&jni, nullptr);
    jstring op = jni->NewString(reinterpret_cast<const jchar*>(args[0].data()), args[0].size());
    jstring path = jni->NewString(reinterpret_cast<const jchar*>(args[1].data()), args[1].size());
    auto value = static_cast<jstring>(jni->CallObjectMethod(storage, call_method, op, path));
    jni->DeleteLocalRef(op);
    jni->DeleteLocalRef(path);
    if (jni->ExceptionCheck() || !value) {
        jni->ExceptionClear();
        if (attached) vm->DetachCurrentThread();
        napi_throw_error(env, "EIO", "Android storage bridge failed");
        return nullptr;
    }
    const jchar* chars = jni->GetStringChars(value, nullptr);
    napi_value result;
    napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(chars), jni->GetStringLength(value), &result);
    jni->ReleaseStringChars(value, chars);
    jni->DeleteLocalRef(value);
    if (attached) vm->DetachCurrentThread();
    return result;
}

NAPI_MODULE_INIT() {
    napi_value fn;
    napi_create_function(env, "call", NAPI_AUTO_LENGTH, Call, nullptr, &fn);
    napi_set_named_property(env, exports, "call", fn);
    return exports;
}

extern "C" JNIEXPORT jint JNICALL Java_ru_inpx_server_NativeRuntime_start(
    JNIEnv* env, jclass, jobjectArray arguments, jobject bridge, jstring native_dir, jstring data_dir) {
    storage = env->NewGlobalRef(bridge);
    auto cls = env->GetObjectClass(bridge);
    call_method = env->GetMethodID(cls, "call", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;");
    env->DeleteLocalRef(cls);
    const char* dir = env->GetStringUTFChars(native_dir, nullptr);
    setenv("INPX_ANDROID_NATIVE_DIR", dir, 1);
    env->ReleaseStringUTFChars(native_dir, dir);
    const char* data = env->GetStringUTFChars(data_dir, nullptr);
    setenv("INPX_ANDROID_DATA_DIR", data, 1);
    chdir(data);
    std::string log_file = std::string(data) + "/node.log";
    FILE* log = fopen(log_file.c_str(), "a");
    if (log) { dup2(fileno(log), STDOUT_FILENO); dup2(fileno(log), STDERR_FILENO); fclose(log); }
    env->ReleaseStringUTFChars(data_dir, data);
    std::vector<std::string> strings;
    size_t total = 0;
    for (jsize i = 0; i < env->GetArrayLength(arguments); ++i) {
        auto arg = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
        const char* s = env->GetStringUTFChars(arg, nullptr);
        strings.emplace_back(s); total += strings.back().size() + 1;
        env->ReleaseStringUTFChars(arg, s); env->DeleteLocalRef(arg);
    }
    std::vector<char> buffer(total);
    std::vector<char*> argv;
    char* position = buffer.data();
    for (const auto& s : strings) { argv.push_back(position); memcpy(position, s.c_str(), s.size() + 1); position += s.size() + 1; }
    int result = node::Start(static_cast<int>(argv.size()), argv.data());
    env->DeleteGlobalRef(storage); storage = nullptr;
    return result;
}
