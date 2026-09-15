package io.github.mobileaidev.aiappbridge.executor;

/** The framework call may still be running; end this test before admitting another action. */
public final class ExecutorUnsettled extends Exception {
    public ExecutorUnsettled(String message, Throwable cause) { super(message, cause); }
}
