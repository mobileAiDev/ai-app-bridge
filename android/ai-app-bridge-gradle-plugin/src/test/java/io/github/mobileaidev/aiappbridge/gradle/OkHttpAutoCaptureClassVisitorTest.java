package io.github.mobileaidev.aiappbridge.gradle;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import java.util.jar.JarOutputStream;
import org.junit.Test;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

public final class OkHttpAutoCaptureClassVisitorTest {
    @Test
    public void insertsInstallBuilderBeforeOkHttpBuild() {
        byte[] transformed = OkHttpAutoCaptureClassVisitor.transform(createClassCallingOkHttpBuild("sample/NetworkFactory"));

        assertEquals(1, countInstallBuilderCalls(transformed));
    }

    @Test
    public void doesNotInstrumentBridgeRuntimeClasses() {
        byte[] transformed = OkHttpAutoCaptureClassVisitor.transform(
                createClassCallingOkHttpBuild("io/github/mobileaidev/aiappbridge/android/InternalFactory")
        );

        assertEquals(0, countInstallBuilderCalls(transformed));
    }

    @Test
    public void filtersKnownRuntimeAndLibraryPackages() {
        assertTrue(OkHttpAutoCaptureClassVisitor.isInstrumentable("com.example.NetworkFactory"));
        assertFalse(OkHttpAutoCaptureClassVisitor.isInstrumentable("io.github.mobileaidev.aiappbridge.android.AiAppBridge"));
        assertFalse(OkHttpAutoCaptureClassVisitor.isInstrumentable("io.github.mobileaidev.aiappbridge.gradle.Plugin"));
        assertFalse(OkHttpAutoCaptureClassVisitor.isInstrumentable("okhttp3.OkHttpClient"));
        assertFalse(OkHttpAutoCaptureClassVisitor.isInstrumentable("okio.Buffer"));
        assertFalse(OkHttpAutoCaptureClassVisitor.isInstrumentable("kotlin.Unit"));
        assertFalse(OkHttpAutoCaptureClassVisitor.isInstrumentable("kotlinx.coroutines.Job"));
    }

    @Test
    public void skipsDuplicateJarEntries() throws Exception {
        File outputFile = File.createTempFile("ai-app-bridge-duplicate-entry", ".jar");
        outputFile.deleteOnExit();
        String entryName = "META-INF/maven/com.belerweb/pinyin4j/pom.xml";
        Set<String> writtenEntries = new HashSet<>();

        try (JarOutputStream output = new JarOutputStream(new FileOutputStream(outputFile))) {
            assertTrue(OkHttpAutoCaptureTransform.writeJarEntry(
                    output,
                    writtenEntries,
                    new JarEntry(entryName),
                    "first".getBytes(StandardCharsets.UTF_8)
            ));
            assertFalse(OkHttpAutoCaptureTransform.writeJarEntry(
                    output,
                    writtenEntries,
                    new JarEntry(entryName),
                    "second".getBytes(StandardCharsets.UTF_8)
            ));
        }

        try (JarFile jarFile = new JarFile(outputFile);
             InputStream input = jarFile.getInputStream(jarFile.getEntry(entryName))) {
            assertEquals("first", new String(readAll(input), StandardCharsets.UTF_8));
        }
    }

    private byte[] createClassCallingOkHttpBuild(String className) {
        ClassWriter writer = new ClassWriter(0);
        writer.visit(Opcodes.V1_8, Opcodes.ACC_PUBLIC, className, null, "java/lang/Object", null);

        MethodVisitor constructor = writer.visitMethod(Opcodes.ACC_PUBLIC, "<init>", "()V", null, null);
        constructor.visitCode();
        constructor.visitVarInsn(Opcodes.ALOAD, 0);
        constructor.visitMethodInsn(Opcodes.INVOKESPECIAL, "java/lang/Object", "<init>", "()V", false);
        constructor.visitInsn(Opcodes.RETURN);
        constructor.visitMaxs(1, 1);
        constructor.visitEnd();

        MethodVisitor method = writer.visitMethod(
                Opcodes.ACC_PUBLIC | Opcodes.ACC_STATIC,
                "create",
                OkHttpAutoCaptureClassVisitor.OKHTTP_BUILD_DESC,
                null,
                null
        );
        method.visitCode();
        method.visitTypeInsn(Opcodes.NEW, OkHttpAutoCaptureClassVisitor.OKHTTP_BUILDER);
        method.visitInsn(Opcodes.DUP);
        method.visitMethodInsn(Opcodes.INVOKESPECIAL, OkHttpAutoCaptureClassVisitor.OKHTTP_BUILDER, "<init>", "()V", false);
        method.visitMethodInsn(
                Opcodes.INVOKEVIRTUAL,
                OkHttpAutoCaptureClassVisitor.OKHTTP_BUILDER,
                "build",
                OkHttpAutoCaptureClassVisitor.OKHTTP_BUILD_DESC,
                false
        );
        method.visitInsn(Opcodes.ARETURN);
        method.visitMaxs(2, 0);
        method.visitEnd();

        writer.visitEnd();
        return writer.toByteArray();
    }

    private byte[] readAll(InputStream input) throws Exception {
        byte[] buffer = new byte[8192];
        int read;
        try (java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream()) {
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        }
    }

    private int countInstallBuilderCalls(byte[] bytecode) {
        ClassReader reader = new ClassReader(bytecode);
        InstallBuilderCountingVisitor visitor = new InstallBuilderCountingVisitor();
        reader.accept(visitor, 0);
        return visitor.count;
    }

    private static final class InstallBuilderCountingVisitor extends ClassVisitor {
        private int count;

        InstallBuilderCountingVisitor() {
            super(Opcodes.ASM9);
        }

        @Override
        public MethodVisitor visitMethod(int access, String name, String descriptor, String signature, String[] exceptions) {
            MethodVisitor next = super.visitMethod(access, name, descriptor, signature, exceptions);
            return new MethodVisitor(Opcodes.ASM9, next) {
                @Override
                public void visitMethodInsn(int opcode, String owner, String methodName, String methodDescriptor, boolean isInterface) {
                    if (opcode == Opcodes.INVOKESTATIC
                            && OkHttpAutoCaptureClassVisitor.HOOK_OWNER.equals(owner)
                            && OkHttpAutoCaptureClassVisitor.HOOK_NAME.equals(methodName)
                            && OkHttpAutoCaptureClassVisitor.HOOK_DESC.equals(methodDescriptor)) {
                        count++;
                    }
                    super.visitMethodInsn(opcode, owner, methodName, methodDescriptor, isInterface);
                }
            };
        }
    }
}
