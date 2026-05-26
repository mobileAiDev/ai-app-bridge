package io.github.mobileaidev.aiappbridge.gradle;

import com.android.build.api.transform.DirectoryInput;
import com.android.build.api.transform.Format;
import com.android.build.api.transform.JarInput;
import com.android.build.api.transform.QualifiedContent;
import com.android.build.api.transform.Transform;
import com.android.build.api.transform.TransformException;
import com.android.build.api.transform.TransformInput;
import com.android.build.api.transform.TransformInvocation;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Collections;
import java.util.Enumeration;
import java.util.EnumSet;
import java.util.HashSet;
import java.util.Set;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import java.util.jar.JarOutputStream;

public final class OkHttpAutoCaptureTransform extends Transform {
    @Override
    public String getName() {
        return "AiAppBridgeOkHttpAutoCapture";
    }

    @Override
    public Set<QualifiedContent.ContentType> getInputTypes() {
        return Collections.singleton(QualifiedContent.DefaultContentType.CLASSES);
    }

    @Override
    public Set<? super QualifiedContent.Scope> getScopes() {
        return EnumSet.of(
                QualifiedContent.Scope.PROJECT,
                QualifiedContent.Scope.SUB_PROJECTS,
                QualifiedContent.Scope.EXTERNAL_LIBRARIES
        );
    }

    @Override
    public boolean isIncremental() {
        return false;
    }

    @Override
    public void transform(TransformInvocation transformInvocation) throws TransformException, InterruptedException, IOException {
        if (transformInvocation.getOutputProvider() == null) {
            return;
        }
        boolean instrument = isDebugVariant(transformInvocation);
        transformInvocation.getOutputProvider().deleteAll();
        for (TransformInput input : transformInvocation.getInputs()) {
            for (DirectoryInput directoryInput : input.getDirectoryInputs()) {
                File output = transformInvocation.getOutputProvider().getContentLocation(
                        directoryInput.getName(),
                        directoryInput.getContentTypes(),
                        directoryInput.getScopes(),
                        Format.DIRECTORY
                );
                copyDirectory(directoryInput.getFile(), output, instrument);
            }
            for (JarInput jarInput : input.getJarInputs()) {
                File output = transformInvocation.getOutputProvider().getContentLocation(
                        jarInput.getName(),
                        jarInput.getContentTypes(),
                        jarInput.getScopes(),
                        Format.JAR
                );
                copyJar(jarInput.getFile(), output, instrument);
            }
        }
    }

    private boolean isDebugVariant(TransformInvocation transformInvocation) {
        String variantName = transformInvocation.getContext().getVariantName();
        return variantName != null && variantName.toLowerCase(java.util.Locale.US).contains("debug");
    }

    private void copyDirectory(File source, File target, boolean instrument) throws IOException {
        if (!source.exists()) {
            return;
        }
        if (source.isDirectory()) {
            File[] children = source.listFiles();
            if (children == null) {
                return;
            }
            if (!target.exists() && !target.mkdirs()) {
                throw new IOException("Failed to create directory " + target);
            }
            for (File child : children) {
                copyDirectory(child, new File(target, child.getName()), instrument);
            }
            return;
        }
        copyFile(source, target, instrument);
    }

    private void copyFile(File source, File target, boolean instrument) throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("Failed to create directory " + parent);
        }
        byte[] bytes = readAll(source);
        if (instrument && source.getName().endsWith(".class")) {
            bytes = OkHttpAutoCaptureClassVisitor.transform(bytes);
        }
        try (OutputStream output = new FileOutputStream(target)) {
            output.write(bytes);
        }
    }

    private void copyJar(File source, File target, boolean instrument) throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("Failed to create directory " + parent);
        }
        try (JarFile jarFile = new JarFile(source);
             JarOutputStream output = new JarOutputStream(new FileOutputStream(target))) {
            Set<String> writtenEntries = new HashSet<>();
            Enumeration<JarEntry> entries = jarFile.entries();
            while (entries.hasMoreElements()) {
                JarEntry entry = entries.nextElement();
                if (writtenEntries.contains(entry.getName())) {
                    continue;
                }
                byte[] bytes = null;
                if (!entry.isDirectory()) {
                    bytes = readAll(jarFile.getInputStream(entry));
                    if (instrument && entry.getName().endsWith(".class")) {
                        bytes = OkHttpAutoCaptureClassVisitor.transform(bytes);
                    }
                }
                writeJarEntry(output, writtenEntries, entry, bytes);
            }
        }
    }

    static boolean writeJarEntry(
            JarOutputStream output,
            Set<String> writtenEntries,
            JarEntry sourceEntry,
            byte[] bytes
    ) throws IOException {
        if (!writtenEntries.add(sourceEntry.getName())) {
            return false;
        }
        JarEntry copiedEntry = new JarEntry(sourceEntry.getName());
        copiedEntry.setTime(sourceEntry.getTime());
        output.putNextEntry(copiedEntry);
        if (bytes != null) {
            output.write(bytes);
        }
        output.closeEntry();
        return true;
    }

    private byte[] readAll(File file) throws IOException {
        try (InputStream input = new FileInputStream(file)) {
            return readAll(input);
        }
    }

    private byte[] readAll(InputStream input) throws IOException {
        byte[] buffer = new byte[8192];
        int read;
        try (java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream()) {
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        }
    }
}
