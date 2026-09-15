package io.github.mobileaidev.aiappbridge.executor;

import android.app.Instrumentation;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Bundle;
import android.os.Process;
import android.os.SystemClock;
import android.util.AtomicFile;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Transport callbacks enqueue; UI operations and test synchronization stay on the test thread. */
public final class ExecutorSession {
    public static final String PROTOCOL = "aab.android-test-executor/v1";
    private final ExecutorAdapter adapter;
    private final JSONObject identity;
    private final String token;
    private final File directory;
    private final LocalServerSocket server;
    private final ArrayBlockingQueue<Command> queue = new ArrayBlockingQueue<>(16);
    private final ConcurrentHashMap<String, Command> commands = new ConcurrentHashMap<>();
    private final ThreadPoolExecutor clients = new ThreadPoolExecutor(4, 4, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<>(16));
    private final ThreadPoolExecutor replies = new ThreadPoolExecutor(2, 2, 0, TimeUnit.SECONDS, new ArrayBlockingQueue<>(32));
    private final Map<LocalSocket, Boolean> sockets = new ConcurrentHashMap<>();
    private volatile boolean closing;
    private volatile long lastRequest = SystemClock.elapsedRealtime();
    private final int leaseMs;
    private volatile Command active;

    public static void run(Instrumentation instrumentation, Bundle arguments, ExecutorAdapter adapter) throws Exception {
        new ExecutorSession(instrumentation, arguments, adapter).loop();
    }

    private ExecutorSession(Instrumentation instrumentation, Bundle arguments, ExecutorAdapter adapter) throws Exception {
        this.adapter = adapter;
        String sessionId = required(arguments, "bridgeSessionId");
        UUID.fromString(sessionId);
        token = required(arguments, "bridgeToken");
        if (!token.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("bridgeToken requires 32 random bytes encoded as hexadecimal");
        leaseMs = Integer.parseInt(arguments.getString("bridgeLeaseMs", "600000"));
        if (leaseMs < 10000 || leaseMs > 3600000) throw new IllegalArgumentException("bridgeLeaseMs must be 10000..3600000");
        String app = instrumentation.getTargetContext().getPackageName();
        identity = new JSONObject().put("protocol", PROTOCOL).put("sessionId", sessionId)
            .put("runtimeEpoch", UUID.randomUUID().toString()).put("targetPackage", app).put("pid", Process.myPid())
            .put("bootId", readText("/proc/sys/kernel/random/boot_id"))
            .put("processStartTicks", processStartTicks());
        directory = new File(instrumentation.getTargetContext().getNoBackupFilesDir(), "ai-app-bridge-executors/" + sessionId);
        if (!directory.mkdirs()) throw new IllegalStateException("Executor session directory already exists or cannot be created");
        server = new LocalServerSocket("aab-test-" + sessionId);
        write(new File(directory, "session.json"), copy(identity).put("capabilities", adapter.capabilities()).put("leaseMs", leaseMs));
    }

    private void loop() throws Exception {
        Thread acceptor = new Thread(() -> {
            while (!closing) {
                try {
                    LocalSocket socket = server.accept();
                    sockets.put(socket, true);
                    try { clients.execute(() -> serve(socket)); }
                    catch (java.util.concurrent.RejectedExecutionException full) { sockets.remove(socket); socket.close(); }
                } catch (java.io.IOException error) { if (!closing) { closing = true; } }
            }
        }, "aab-test-accept");
        acceptor.start();
        try {
            while (!closing) {
                Command command = queue.poll(25, TimeUnit.MILLISECONDS);
                if (command == null) {
                    adapter.idle();
                    if (SystemClock.elapsedRealtime() - lastRequest >= leaseMs) closing = true;
                    continue;
                }
                active = command;
                try { reply(command.socket, execute(command)); }
                catch (ExecutorUnsettled error) { closing = true; reply(command.socket, failed("executor_completion_unknown", error.getMessage(), true)); }
                catch (ExecutorFailure error) { reply(command.socket, failed(error.code, error.getMessage(), error.dispatched)); }
                catch (Exception | AssertionError error) { reply(command.socket, failed("executor_failed", error.toString(), command.request.optString("operation").equals("act"))); }
                finally { active = null; commands.remove(command.id); }
            }
        } finally {
            closing = true;
            server.close();
            for (Command pending : queue) reply(pending.socket, failed("executor_closed", "Executor session is closing", false));
            adapter.close();
            write(new File(directory, "closed.json"), copy(identity).put("settled", true).put("closedAtMs", System.currentTimeMillis()));
            clients.shutdown();
            replies.shutdown();
            if (!clients.awaitTermination(2, TimeUnit.SECONDS)) {
                for (LocalSocket socket : sockets.keySet()) socket.close();
                clients.shutdownNow();
                if (!clients.awaitTermination(2, TimeUnit.SECONDS)) throw new IllegalStateException("Executor transport did not terminate");
            }
            if (!replies.awaitTermination(2, TimeUnit.SECONDS)) {
                for (LocalSocket socket : sockets.keySet()) socket.close();
                replies.shutdownNow();
            }
            acceptor.join(2000);
        }
    }

    private void serve(LocalSocket socket) {
        boolean handedOff = false;
        try {
            LocalSocket connection = socket;
            connection.setSoTimeout(5000);
            JSONObject request = new JSONObject(readLine(connection.getInputStream()));
            JSONObject response;
            if (!MessageDigest.isEqual(token.getBytes(StandardCharsets.UTF_8), request.getString("token").getBytes(StandardCharsets.UTF_8)))
                response = failed("executor_unauthorized", "Executor token does not match", false);
            else if (!PROTOCOL.equals(request.getString("protocol")) || !identity.getString("sessionId").equals(request.getString("sessionId")))
                response = failed("executor_session_mismatch", "Executor protocol/session changed", false);
            else {
                String operation = request.getString("operation");
                if (!operation.equals("status") && !identity.getString("runtimeEpoch").equals(request.getString("runtimeEpoch")))
                    response = failed("executor_session_mismatch", "Executor generation changed", false);
                else {
                    lastRequest = SystemClock.elapsedRealtime();
                    if (operation.equals("status")) response = copy(identity).put("ok", true).put("capabilities", adapter.capabilities())
                        .put("activeRequestId", active == null ? JSONObject.NULL : active.id).put("closing", closing);
                    else if (operation.equals("receipt")) {
                        JSONObject receipt = readReceipt(request.getString("actionId"));
                        response = copy(identity).put("ok", receipt != null).put("receipt", receipt == null ? JSONObject.NULL : receipt);
                    } else if (operation.equals("cancel")) {
                        Command command = commands.get(request.getString("requestId"));
                        if (command != null) command.cancelled = true;
                        response = copy(identity).put("ok", true).put("cancelRequested", command != null).put("settled", command == null);
                    } else if (closing) response = failed("executor_closed", "Executor session is closing", false);
                    else {
                        Command command = new Command(request, connection);
                        if (commands.putIfAbsent(command.id, command) != null) response = failed("executor_request_active", "This requestId is already active", false);
                        else if (!queue.offer(command)) { commands.remove(command.id); response = failed("executor_queue_full", "Executor queue is full", false); }
                        else { handedOff = true; return; }
                    }
                }
            }
            reply(connection, response);
            handedOff = true;
        } catch (Exception error) {
            // A lost transport does not cancel a dispatched UI effect. Its durable receipt remains authoritative.
            android.util.Log.w("AiBridgeExecutor", "Executor transport ended: " + error.getClass().getSimpleName());
        } finally { if (!handedOff) closeSocket(socket); }
    }

    private void reply(LocalSocket socket, JSONObject response) throws Exception {
        byte[] output = (response.toString() + "\n").getBytes(StandardCharsets.UTF_8);
        if (output.length > 4 * 1024 * 1024) output = (failed("executor_response_limit", "Executor response exceeds 4 MiB; query the original receipt", response.optBoolean("dispatched")).toString() + "\n").getBytes(StandardCharsets.UTF_8);
        final byte[] bytes = output;
        try { replies.execute(() -> {
            try { socket.getOutputStream().write(bytes); socket.getOutputStream().flush(); }
            catch (java.io.IOException error) { android.util.Log.w("AiBridgeExecutor", "Reply transport ended"); }
            finally { closeSocket(socket); }
        }); } catch (java.util.concurrent.RejectedExecutionException full) { closeSocket(socket); }
    }

    private void closeSocket(LocalSocket socket) {
        sockets.remove(socket);
        try { socket.close(); } catch (java.io.IOException error) { android.util.Log.w("AiBridgeExecutor", "Socket close failed"); }
    }

    private JSONObject execute(Command command) throws Exception {
        JSONObject request = command.request;
        if (!request.getString("operation").equals("act") && (command.cancelled || SystemClock.elapsedRealtime() >= command.deadline))
            return failed("executor_cancelled", "Request expired or was cancelled before execution", false);
        String operation = request.getString("operation");
        if (operation.equals("close")) { closing = true; return copy(identity).put("ok", true).put("closing", true); }
        if (operation.equals("observe")) return copy(identity).put("ok", true).put("observation", adapter.observe(request));
        if (!operation.equals("act")) return failed("executor_operation_unsupported", "Unsupported executor operation", false);
        String actionId = request.getString("actionId");
        JSONObject effect = new JSONObject().put("snapshotId", request.getString("snapshotId")).put("action", request.getJSONObject("action"));
        String digest = hash(canonical(effect).toString());
        JSONObject previous = readReceipt(actionId);
        if (previous != null) {
            if (!digest.equals(previous.getString("requestDigest"))) return failed("idempotency_conflict", "actionId already identifies a different action", false);
            if (!previous.getBoolean("settled")) return failed("executor_action_unresolved", "The original action has no completion receipt", false);
            return copy(previous.getJSONObject("result")).put("replayed", true).put("executionReceipt", previous);
        }
        File receipts = new File(directory, "receipts");
        if (!receipts.exists() && !receipts.mkdir()) throw new IllegalStateException("Cannot create receipt directory");
        String[] retained = receipts.list((dir, name) -> name.endsWith(".json"));
        if (retained == null || retained.length >= 4096) return failed("executor_receipt_capacity", "Close this session before creating further actions", false);
        File file = new File(receipts, hash(actionId) + ".json");
        long start = SystemClock.elapsedRealtime();
        JSONObject receipt = copy(identity).put("actionId", actionId).put("requestDigest", digest).put("settled", false).put("phase", "started");
        write(file, receipt);
        JSONObject result;
        try {
            if (command.cancelled || SystemClock.elapsedRealtime() >= command.deadline)
                result = failed("executor_cancelled", "Request expired or was cancelled before execution", false);
            else result = copy(identity).put("ok", true).put("dispatched", true).put("ambiguous", false).put("action", adapter.act(request));
        } catch (ExecutorUnsettled error) {
            closing = true;
            return failed("executor_completion_unknown", error.getMessage(), true).put("actionId", actionId).put("executionReceipt", receipt);
        } catch (ExecutorFailure error) { result = failed(error.code, error.getMessage(), error.dispatched); }
        catch (Exception | AssertionError error) { result = failed("executor_action_failed", error.toString(), true); }
        result.put("actionId", actionId).put("cancelRequested", command.cancelled).put("executionMs", SystemClock.elapsedRealtime() - start);
        receipt.put("phase", "completed").put("settled", true).put("result", copy(result)).put("completedAtMs", System.currentTimeMillis());
        write(file, receipt);
        return result.put("executionReceipt", receipt);
    }

    private JSONObject failed(String code, String message, boolean dispatched) throws Exception {
        return copy(identity).put("ok", false).put("error", code).put("message", message)
            .put("dispatched", dispatched).put("ambiguous", dispatched);
    }
    private JSONObject readReceipt(String actionId) throws Exception {
        File file = new File(new File(directory, "receipts"), hash(actionId) + ".json");
        if (!file.exists()) return null;
        JSONObject receipt = new JSONObject(new String(new AtomicFile(file).readFully(), StandardCharsets.UTF_8));
        if (!actionId.equals(receipt.getString("actionId"))) throw new IllegalStateException("Receipt identity mismatch");
        return receipt;
    }
    private static void write(File file, JSONObject value) throws Exception {
        AtomicFile atomic = new AtomicFile(file);
        FileOutputStream output = atomic.startWrite();
        try { output.write(value.toString().getBytes(StandardCharsets.UTF_8)); atomic.finishWrite(output); }
        catch (Exception error) { atomic.failWrite(output); throw error; }
        java.io.FileDescriptor directoryFd = android.system.Os.open(file.getParent(), android.system.OsConstants.O_RDONLY, 0);
        try { android.system.Os.fsync(directoryFd); } finally { android.system.Os.close(directoryFd); }
    }
    private static JSONObject copy(JSONObject value) throws Exception { return new JSONObject(value.toString()); }
    private static String readText(String file) throws Exception {
        try (FileInputStream input = new FileInputStream(file)) { return readLine(input).trim(); }
    }
    private static String processStartTicks() throws Exception {
        String stat = readText("/proc/self/stat");
        String ticks = stat.substring(stat.lastIndexOf(") ") + 2).split("\\s+")[19];
        if (!ticks.matches("[0-9]+")) throw new IllegalStateException("Invalid process start identity");
        return ticks;
    }
    private static String required(Bundle arguments, String key) {
        String value = arguments.getString(key);
        if (value == null || value.isEmpty()) throw new IllegalArgumentException(key + " is required");
        return value;
    }
    private static String readLine(InputStream input) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        int value;
        while ((value = input.read()) != -1 && value != '\n') {
            if (bytes.size() >= 1024 * 1024) throw new IllegalArgumentException("Executor request exceeds 1 MiB");
            bytes.write(value);
        }
        return bytes.toString("UTF-8");
    }
    private static String hash(String value) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder result = new StringBuilder();
        for (byte item : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", item & 255));
        return result.toString();
    }
    private static Object canonical(Object value) throws Exception {
        if (value instanceof JSONObject) {
            ArrayList<String> keys = new ArrayList<>();
            Iterator<String> iterator = ((JSONObject) value).keys();
            while (iterator.hasNext()) keys.add(iterator.next());
            Collections.sort(keys);
            JSONObject result = new JSONObject();
            for (String key : keys) result.put(key, canonical(((JSONObject) value).get(key)));
            return result;
        }
        if (value instanceof JSONArray) {
            JSONArray result = new JSONArray();
            for (int index = 0; index < ((JSONArray) value).length(); index++) result.put(canonical(((JSONArray) value).get(index)));
            return result;
        }
        return value;
    }
    private static final class Command {
        final String id;
        final JSONObject request;
        final long deadline;
        final LocalSocket socket;
        volatile boolean cancelled;
        Command(JSONObject request, LocalSocket socket) throws Exception {
            this.request = request;
            this.socket = socket;
            id = request.getString("requestId");
            long timeout = request.optLong("timeoutMs", 30000);
            if (timeout < 1 || timeout > 300000) throw new IllegalArgumentException("timeoutMs must be 1..300000");
            deadline = SystemClock.elapsedRealtime() + timeout;
        }
    }
}
