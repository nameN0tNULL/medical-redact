package stirling.software.SPDF.medicalredact;

import java.io.IOException;
import java.util.concurrent.Semaphore;
import java.util.function.Supplier;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import stirling.software.SPDF.medicalredact.MedicalRedactModels.WorkerSchedule;

@Service
class MedicalRedactWorkerScheduler {

    private final WorkerSchedule schedule;
    private final Semaphore ocrSlots;
    private final Semaphore nerSlots;
    private final Semaphore preprocessSlots;

    @Autowired
    MedicalRedactWorkerScheduler(MedicalRedactRuntimeCapabilitiesService capabilitiesService) {
        this(capabilitiesService.probe().workerSchedule());
    }

    MedicalRedactWorkerScheduler(WorkerSchedule schedule) {
        this.schedule = schedule;
        this.ocrSlots = new Semaphore(schedule.ocrWorkers(), true);
        this.nerSlots = new Semaphore(schedule.nerWorkers(), true);
        this.preprocessSlots = new Semaphore(schedule.preprocessWorkers(), true);
    }

    WorkerSchedule schedule() {
        return schedule;
    }

    int renderCachePages() {
        return schedule.renderCachePages();
    }

    <T> T runOcr(Supplier<T> operation) {
        return run(ocrSlots, operation);
    }

    <T> T runNer(Supplier<T> operation) {
        return run(nerSlots, operation);
    }

    <T> T runPreprocess(IoSupplier<T> operation) throws IOException {
        acquire(preprocessSlots);
        try {
            return operation.get();
        } finally {
            preprocessSlots.release();
        }
    }

    private static <T> T run(Semaphore semaphore, Supplier<T> operation) {
        acquireUnchecked(semaphore);
        try {
            return operation.get();
        } finally {
            semaphore.release();
        }
    }

    private static void acquire(Semaphore semaphore) throws IOException {
        try {
            semaphore.acquire();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Medical redact worker scheduling was interrupted", e);
        }
    }

    private static void acquireUnchecked(Semaphore semaphore) {
        try {
            semaphore.acquire();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Medical redact worker scheduling was interrupted", e);
        }
    }

    @FunctionalInterface
    interface IoSupplier<T> {
        T get() throws IOException;
    }
}
