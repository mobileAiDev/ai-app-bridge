package io.github.mobileaidev.aiappbridge.uia;

import java.nio.file.Files;
import java.nio.file.Path;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;

public class UiaResetTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void forceResetIdentifiesLiveAppProcessLaunchNames() {
        String main = "io.github.mobileaidev.aiappbridge.uia.UiaRuntime";
        assertTrue(UiaReset.isUiaProcess(new String[] { "app_process", "/system/bin", main }, main));
        assertTrue(UiaReset.isUiaProcess(new String[] { "app_process64", "/system/bin", main }, main));
        assertTrue(UiaReset.isUiaProcess(new String[] { "/system/bin/app_process64", "/system/bin", main }, main));
        assertTrue(UiaReset.isUiaProcess(new String[] { main }, main));
        assertFalse(UiaReset.isUiaProcess(new String[] { "app_process", "/system/bin", "other.application.Main" }, main));
    }

    @Test public void forceResetArchivesUnknownAndCorruptRecordsWithoutTerminalProof() throws Exception {
        Path root = temporary.newFolder().toPath().toRealPath();
        Path actions = root.resolve("sessions/old/actions"); Files.createDirectories(actions);
        Files.writeString(actions.resolve("unknown.json"), "{\"phase\":\"admitted\"}");
        Files.writeString(actions.resolve("corrupt.json"), "{broken");
        Files.writeString(root.resolve("runtime.json"), "{broken descriptor");
        Path lock = root.resolve("owner.lock"); Files.writeString(lock, "same inode");
        JSONObject reset = UiaReset.archive(root.toFile(), JvmPosix.FILES);
        assertTrue(reset.getBoolean("stopped"));
        assertEquals("unknown", reset.getString("outcome"));
        assertFalse(Files.exists(root.resolve("sessions")));
        assertFalse(Files.exists(root.resolve("runtime.json")));
        Path archive = Path.of(reset.getString("archivePath"));
        assertEquals("{broken", Files.readString(archive.resolve("sessions/old/actions/corrupt.json")));
        assertEquals("{\"phase\":\"admitted\"}", Files.readString(archive.resolve("sessions/old/actions/unknown.json")));
        assertEquals("same inode", Files.readString(lock));
        new UiaJournal(root.toFile(), JvmPosix.FILES).prepare("a".repeat(64));
    }
}
