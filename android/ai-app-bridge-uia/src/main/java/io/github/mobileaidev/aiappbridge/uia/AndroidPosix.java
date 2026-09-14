package io.github.mobileaidev.aiappbridge.uia;

import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import java.io.File;
import java.io.FileDescriptor;

/** API 21+ calls preserving the journal's atomic rename and directory fsync contract. */
final class AndroidPosix implements DurableFiles.Posix {
    @Override public boolean exists(File file) throws Exception {
        try { Os.lstat(file.getPath()); return true; }
        catch (ErrnoException error) {
            if (error.errno == OsConstants.ENOENT) return false;
            throw error;
        }
    }
    @Override public void chmod(File file, int mode) throws Exception { Os.chmod(file.getPath(), mode); }
    @Override public void rename(File source, File destination) throws Exception { Os.rename(source.getPath(), destination.getPath()); }
    @Override public void syncDirectory(File directory) throws Exception {
        FileDescriptor fd = Os.open(directory.getPath(), OsConstants.O_RDONLY | OsConstants.O_NOFOLLOW | OsConstants.O_CLOEXEC, 0);
        try {
            if (!OsConstants.S_ISDIR(Os.fstat(fd).st_mode)) throw new java.io.IOException("Journal sync requires a directory");
            Os.fsync(fd);
        } finally { Os.close(fd); }
    }
}
