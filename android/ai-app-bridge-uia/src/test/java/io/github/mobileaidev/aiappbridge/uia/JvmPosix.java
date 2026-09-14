package io.github.mobileaidev.aiappbridge.uia;

import java.io.File;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;

/** Real host filesystem for journal tests; Android calls are verified on the device. */
final class JvmPosix implements DurableFiles.Posix {
    static final DurableFiles FILES = new DurableFiles(new JvmPosix());
    @Override public boolean exists(File file) { return Files.exists(file.toPath(), LinkOption.NOFOLLOW_LINKS); }
    @Override public void chmod(File file, int mode) throws Exception {
        if (mode != 0700) throw new AssertionError("Unexpected journal mode");
        Files.setPosixFilePermissions(file.toPath(), PosixFilePermissions.fromString("rwx------"));
    }
    @Override public void rename(File source, File destination) throws Exception {
        Files.move(source.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }
    @Override public void syncDirectory(File directory) throws Exception {
        try (FileChannel channel = FileChannel.open(directory.toPath(), StandardOpenOption.READ)) { channel.force(true); }
    }
}
