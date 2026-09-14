package io.github.mobileaidev.aiappbridge.gradle;

public class AiAppBridgeExtension {
    private final java.util.Set<String> unusedOptions = new java.util.LinkedHashSet<>();
    private boolean enabled = true;
    private boolean okHttpCaptureEnabled = true;
    private boolean webSocketCaptureEnabled = false;
    private boolean logInstrumentationEnabled = false;
    private boolean webViewDebuggingEnabled = true;
    private String runtimeDependencyNotation = "";

    public boolean isEnabled() {
        return enabled;
    }

    public boolean getEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public boolean isOkHttpCaptureEnabled() {
        return okHttpCaptureEnabled;
    }

    public boolean getOkHttpCaptureEnabled() {
        return okHttpCaptureEnabled;
    }

    public void setOkHttpCaptureEnabled(boolean okHttpCaptureEnabled) {
        this.okHttpCaptureEnabled = okHttpCaptureEnabled;
    }

    /** @deprecated This option has no instrumentation implementation. */
    @Deprecated
    public boolean isWebSocketCaptureEnabled() {
        return webSocketCaptureEnabled;
    }

    /** @deprecated This option has no instrumentation implementation. */
    @Deprecated
    public boolean getWebSocketCaptureEnabled() {
        return webSocketCaptureEnabled;
    }

    /** @deprecated Retained for existing build scripts; setting it emits an explicit warning. */
    @Deprecated
    public void setWebSocketCaptureEnabled(boolean webSocketCaptureEnabled) {
        unusedOptions.add("webSocketCaptureEnabled");
        this.webSocketCaptureEnabled = webSocketCaptureEnabled;
    }

    /** @deprecated This option has no instrumentation implementation. */
    @Deprecated
    public boolean isLogInstrumentationEnabled() {
        return logInstrumentationEnabled;
    }

    /** @deprecated This option has no instrumentation implementation. */
    @Deprecated
    public boolean getLogInstrumentationEnabled() {
        return logInstrumentationEnabled;
    }

    /** @deprecated Retained for existing build scripts; setting it emits an explicit warning. */
    @Deprecated
    public void setLogInstrumentationEnabled(boolean logInstrumentationEnabled) {
        unusedOptions.add("logInstrumentationEnabled");
        this.logInstrumentationEnabled = logInstrumentationEnabled;
    }

    /** @deprecated This option has no instrumentation implementation. */
    @Deprecated
    public boolean isWebViewDebuggingEnabled() {
        return webViewDebuggingEnabled;
    }

    /** @deprecated This option has no instrumentation implementation. */
    @Deprecated
    public boolean getWebViewDebuggingEnabled() {
        return webViewDebuggingEnabled;
    }

    /** @deprecated Retained for existing build scripts; setting it emits an explicit warning. */
    @Deprecated
    public void setWebViewDebuggingEnabled(boolean webViewDebuggingEnabled) {
        unusedOptions.add("webViewDebuggingEnabled");
        this.webViewDebuggingEnabled = webViewDebuggingEnabled;
    }

    java.util.Set<String> getUnusedOptions() {
        return java.util.Collections.unmodifiableSet(unusedOptions);
    }

    public String getRuntimeDependencyNotation() {
        return runtimeDependencyNotation;
    }

    public void setRuntimeDependencyNotation(String runtimeDependencyNotation) {
        this.runtimeDependencyNotation = runtimeDependencyNotation == null ? "" : runtimeDependencyNotation;
    }
}

