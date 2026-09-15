package io.github.mobileaidev.aiappbridge.executor;

import org.json.JSONObject;

/** Called serially on the instrumentation test thread throughout one JUnit test. */
public interface ExecutorAdapter {
    JSONObject capabilities() throws Exception;
    JSONObject observe(JSONObject request) throws Exception;
    JSONObject act(JSONObject request) throws Exception;
    default void idle() throws Exception {}
    default void close() throws Exception {}
}
