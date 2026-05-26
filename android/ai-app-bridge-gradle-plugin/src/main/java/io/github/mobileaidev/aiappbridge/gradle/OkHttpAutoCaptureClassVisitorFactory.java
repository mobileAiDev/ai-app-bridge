package io.github.mobileaidev.aiappbridge.gradle;

import com.android.build.api.instrumentation.AsmClassVisitorFactory;
import com.android.build.api.instrumentation.ClassContext;
import com.android.build.api.instrumentation.ClassData;
import com.android.build.api.instrumentation.InstrumentationParameters;
import org.objectweb.asm.ClassVisitor;

public abstract class OkHttpAutoCaptureClassVisitorFactory
        implements AsmClassVisitorFactory<InstrumentationParameters.None> {
    @Override
    public ClassVisitor createClassVisitor(ClassContext classContext, ClassVisitor nextClassVisitor) {
        return OkHttpAutoCaptureClassVisitor.wrap(nextClassVisitor);
    }

    @Override
    public boolean isInstrumentable(ClassData classData) {
        return OkHttpAutoCaptureClassVisitor.isInstrumentable(classData.getClassName());
    }
}

