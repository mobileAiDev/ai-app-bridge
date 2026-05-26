-keep class io.github.mobileaidev.aiappbridge.android.AiAppBridgeInitProvider {
    public <init>();
}

-keep class io.github.mobileaidev.aiappbridge.android.AiAppBridge {
    public static final io.github.mobileaidev.aiappbridge.android.AiAppBridge INSTANCE;
    public static final void start(android.content.Context);
}
