package ru.inpx.server;

final class NativeRuntime {
  static {
    System.loadLibrary("inpxbridge");
  }

  static native int start(
      String[] arguments, StorageBridge storage, String nativeDir, String dataDir);
}
