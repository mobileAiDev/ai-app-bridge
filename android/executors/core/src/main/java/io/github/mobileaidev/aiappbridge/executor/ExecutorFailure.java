package io.github.mobileaidev.aiappbridge.executor;

public final class ExecutorFailure extends Exception {
    public final String code;
    public final boolean dispatched;
    public ExecutorFailure(String code, String message) { this(code, message, false); }
    public ExecutorFailure(String code, String message, boolean dispatched) { super(message); this.code = code; this.dispatched = dispatched; }
}
