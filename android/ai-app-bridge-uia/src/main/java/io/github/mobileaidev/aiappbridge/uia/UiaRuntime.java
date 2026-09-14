package io.github.mobileaidev.aiappbridge.uia;

import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.os.Build;
import android.os.Looper;
import android.os.SystemClock;
import org.json.JSONObject;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.io.File;
import java.io.RandomAccessFile;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** A shell-owned runtime independent of any Host process, with no application APK dependency. */
public final class UiaRuntime {
    private final String bootId, epoch, dexHash, token;
    private static final DurableFiles files = new DurableFiles(new AndroidPosix());
    private final File root, session;
    private final UiaConnection connection;
    private final UiaNodes nodes;
    private final UiaActionEngine actions;
    private final LocalServerSocket server;
    private final ThreadPoolExecutor worker = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(32));
    private final ThreadPoolExecutor clients = new ThreadPoolExecutor(2, 2, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(4));
    private volatile boolean stopping;

    private UiaRuntime(File root, String dexHash) throws Exception {
        this.root = root; this.dexHash = dexHash;
        bootId = DurableFiles.read(new File("/proc/sys/kernel/random/boot_id"), 128).trim();
        epoch = UUID.randomUUID().toString();
        token = UUID.randomUUID().toString().replace("-", "") + UUID.randomUUID().toString().replace("-", "");
        File sessions = new File(root, "sessions");
        new UiaJournal(root, files).prepare(dexHash);
        session = new File(sessions, epoch); files.directory(session); files.directory(new File(session, "actions"));
        files.syncDirectory(sessions); files.syncDirectory(root);
        connection = new UiaConnection();
        LocalServerSocket opened;
        try { opened = new LocalServerSocket("aab-uia-" + epoch); }
        catch (Exception error) { connection.close(); throw error; }
        server = opened;
        nodes = new UiaNodes(connection, bootId, epoch);
        actions = new UiaActionEngine(bootId, epoch, UiaJournal.ACTION_CAPACITY,
            (id, record) -> files.write(new File(new File(session, "actions"), Wire.sha256(id) + ".json"), record.toString()),
            nodes, worker, SystemClock::elapsedRealtime);
        try { publish(true); }
        catch (Exception error) { server.close(); connection.close(); throw error; }
    }

    private void publish(boolean running) throws Exception {
        JSONObject descriptor = new JSONObject().put("schemaVersion", "aab.uia.runtime.v1").put("bootId", bootId)
            .put("runtimeEpoch", epoch).put("dexSha256", dexHash).put("apiLevel", Build.VERSION.SDK_INT)
            .put("pid", android.os.Process.myPid()).put("socketName", "aab-uia-" + epoch).put("token", token)
            .put("sessionPath", session.toString()).put("running", running);
        files.write(new File(session, "runtime.json"), descriptor.toString());
        files.write(new File(root, "runtime.json"), descriptor.toString());
    }

    private JSONObject handle(JSONObject request) throws Exception {
        String operation = Wire.string(request, "op");
        if (operation.equals("status")) { Wire.keys(request, "op"); return actions.status().put("dexSha256", dexHash); }
        if (operation.equals("stop")) {
            Wire.keys(request, "op");
            if (!actions.beginClose()) throw new Wire.Failure("uia_runtime_has_pending_actions");
            stopping = true;
            // Closing a listening fd on another thread does not reliably wake an in-flight accept.
            // Wake the sole acceptor explicitly; that thread owns final listener closure.
            try (LocalSocket wakeup = new LocalSocket()) {
                wakeup.connect(new LocalSocketAddress("aab-uia-" + epoch, LocalSocketAddress.Namespace.ABSTRACT));
            }
            return new JSONObject().put("ok", true).put("runtimeEpoch", epoch).put("stopping", true);
        }
        if (operation.equals("observe")) {
            Wire.keys(request, "op");
            if (stopping) throw new Wire.Failure("uia_runtime_closing");
            java.util.concurrent.Future<JSONObject> observation = worker.submit(nodes::observe);
            try { return observation.get(6000, TimeUnit.MILLISECONDS); }
            catch (TimeoutException error) {
                observation.cancel(true);
                throw new Wire.Failure("uia_observation_timeout", error);
            }
            catch (ExecutionException error) {
                if (error.getCause() instanceof Exception) throw (Exception) error.getCause();
                throw error;
            }
        }
        if (operation.equals("acknowledge")) {
            Wire.keys(request, "op", "requestJson", "requestSha256", "receiptSha256");
            return actions.acknowledge(Wire.string(request, "requestJson"), Wire.string(request, "requestSha256"), Wire.string(request, "receiptSha256"));
        }
        if (operation.equals("acknowledge-record")) {
            Wire.keys(request, "op", "identity");
            return new UiaJournal(root, files).acknowledge(Wire.object(request, "identity"), epoch);
        }
        Wire.keys(request, "op", "requestJson", "requestSha256");
        String raw = Wire.string(request, "requestJson"), hash = Wire.string(request, "requestSha256");
        switch (operation) {
            case "prepare": return actions.prepare(raw, hash);
            case "start": return actions.start(raw, hash);
            case "query": return actions.query(raw, hash);
            case "cancel": return actions.cancel(raw, hash);
            default: throw new Wire.Failure("uia_unknown_operation");
        }
    }

    private void run() throws Exception {
        try {
            while (!stopping) {
                LocalSocket socket;
                try { socket = server.accept(); }
                catch (Exception error) { if (stopping) break; throw error; }
                if (stopping) { socket.close(); break; }
                try { clients.execute(() -> UiaHttp.serve(socket, token, this::handle)); }
                catch (RuntimeException busy) { socket.close(); }
            }
        } finally {
            // A fatal listener error must still leave Binder callbacks alive until original receipts are durable.
            while (!actions.beginClose()) Thread.sleep(1000);
            clients.shutdown(); clients.awaitTermination(10, TimeUnit.SECONDS);
            worker.shutdown();
            while (!worker.awaitTermination(10, TimeUnit.SECONDS)) { /* drain observations before disconnecting */ }
            connection.close(); server.close(); publish(false);
        }
    }

    public static void main(String[] args) {
        try {
            if (Build.VERSION.SDK_INT < 25) throw new Wire.Failure("uia_android_api_25_required");
            boolean ownerStatus = args.length == 3 && args[2].equals("owner-status");
            boolean acknowledge = args.length == 4 && args[2].equals("acknowledge-record");
            boolean recover = args.length == 4 && args[2].equals("recover-record");
            if (args.length != 2 && !ownerStatus && !acknowledge && !recover || !args[1].matches("[0-9a-f]{64}")) throw new Wire.Failure("uia_invalid_start_arguments");
            File root = new File(args[0]).getAbsoluteFile();
            if (!root.toString().equals("/data/local/tmp/ai-app-bridge-uia/v1")
                    && !root.toString().matches("/data/local/tmp/ai-app-bridge-uia-test-[a-z0-9-]+"))
                throw new Wire.Failure("uia_invalid_runtime_root");
            String classpath = System.getenv("CLASSPATH");
            if (classpath == null || !Wire.sha256(DurableFiles.readBytes(new File(classpath), 2 * 1024 * 1024)).equals(args[1]))
                throw new Wire.Failure("uia_runtime_artifact_mismatch");
            files.directory(root);
            try (RandomAccessFile lockFile = new RandomAccessFile(new File(root, "owner.lock"), "rw");
                 FileChannel channel = lockFile.getChannel()) {
                FileLock lock = channel.tryLock();
                if (ownerStatus) {
                    try {
                        System.out.println(new JSONObject().put("ok", true).put("schemaVersion", "aab.uia.owner.v1")
                            .put("root", root.toString()).put("dexSha256", args[1]).put("owned", lock == null));
                    } finally { if (lock != null) lock.release(); }
                    return;
                }
                if (lock == null) throw new Wire.Failure("uia_runtime_already_running");
                try {
                    if (acknowledge || recover) {
                        if (args[3].length() > 1024) throw new Wire.Failure("uia_completion_identity_mismatch");
                        UiaJournal journal = new UiaJournal(root, files);
                        JSONObject identity = new JSONObject(args[3]);
                        System.out.println(acknowledge ? journal.acknowledge(identity, null) : journal.recover(identity,
                            DurableFiles.read(new File("/proc/sys/kernel/random/boot_id"), 128).trim(), SystemClock.elapsedRealtime(), args[1]));
                        return;
                    }
                    Looper.prepareMainLooper();
                    new UiaRuntime(root, args[1]).run();
                } finally { lock.release(); }
            }
        } catch (Exception error) {
            try { System.err.println(Wire.failure(error)); }
            catch (Exception formatting) { System.err.println(error.toString()); }
            System.exit(2);
        }
    }
}
