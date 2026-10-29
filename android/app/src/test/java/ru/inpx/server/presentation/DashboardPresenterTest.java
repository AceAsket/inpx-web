package ru.inpx.server.presentation;

import static org.junit.Assert.*;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.Executor;
import org.junit.Test;

/** Controlled queues exercise lifecycle and stale-result races without an emulator or sleeps. */
public final class DashboardPresenterTest {
  private static DashboardState state(DashboardState.Phase phase) {
    return new DashboardState(
        phase,
        Collections.emptyList(),
        Collections.singletonList("192.168.1.20"),
        "status",
        "logs",
        "tv",
        12380,
        12380,
        true,
        false,
        false,
        42);
  }

  private static final class QueueExecutor implements Executor {
    final Queue<Runnable> queue = new ArrayDeque<>();

    public void execute(Runnable task) {
      queue.add(task);
    }

    void next() {
      assertFalse("No queued work", queue.isEmpty());
      queue.remove().run();
    }
  }

  private static final class Ui implements DashboardPresenter.Scheduler, DashboardPresenter.View {
    final Queue<Runnable> posted = new ArrayDeque<>();
    final List<Runnable> delayed = new ArrayList<>();
    final List<DashboardState> rendered = new ArrayList<>();
    int errors;

    public void post(Runnable task) {
      posted.add(task);
    }

    public void after(Runnable task, long millis) {
      delayed.add(task);
    }

    public void cancel(Runnable task) {
      delayed.remove(task);
    }

    public void render(DashboardState state) {
      rendered.add(state);
    }

    public void error(Throwable error) {
      errors++;
    }

    public void message(String message) {}

    void drain() {
      while (!posted.isEmpty()) posted.remove().run();
    }
  }

  private static final class Repository implements ServerRepository {
    DashboardState snapshot = state(DashboardState.Phase.STOPPED);
    boolean failStart, failStop;
    int starts, stops, checks, port;

    public DashboardState load() {
      return snapshot;
    }

    public void start(boolean demo) throws Exception {
      starts++;
      if (failStart) throw new Exception("Start failed");
      snapshot = state(DashboardState.Phase.STARTING);
    }

    public void stop() throws Exception {
      stops++;
      if (failStop) throw new Exception("Stop failed");
      snapshot = state(DashboardState.Phase.STOPPING);
    }

    public void checkSources() {
      checks++;
    }

    public SourceDraft source(String id) {
      return SourceDraft.tree(id, "Books", "content://test");
    }

    public void saveSource(SourceDraft source) {}

    public void removeSource(String id) {}

    public void savePort(int port) {
      this.port = port;
    }

    public void saveMode(String mode) {}

    public PowerSettings power() {
      return new PowerSettings(true, false, false, true, false, false, false);
    }

    public void savePower(boolean awake, boolean boot, boolean battery) {}
  }

  private static final class Fixture {
    final Repository repository = new Repository();
    final QueueExecutor worker = new QueueExecutor(), sourceWorker = new QueueExecutor();
    final Ui ui = new Ui();
    final DashboardPresenter presenter =
        new DashboardPresenter(repository, worker, sourceWorker, ui, ui);

    void load() {
      presenter.resume();
      worker.next();
      ui.drain();
    }
  }

  @Test
  public void stalePollCannotUndoStartAndDoubleClickStartsOnce() {
    Fixture f = new Fixture();
    f.load();
    f.ui.delayed.remove(0).run();
    f.worker.next(); // Old stopped snapshot is now waiting on the UI queue.
    f.presenter.start(true);
    f.presenter.start(true);
    f.ui.drain();
    assertEquals(DashboardState.Phase.STARTING, f.presenter.state().phase);
    f.worker.next();
    f.ui.drain();
    assertEquals(1, f.repository.starts);
    assertEquals(DashboardState.Phase.STARTING, f.presenter.state().phase);
  }

  @Test
  public void pauseDiscardsReadAndResumeLoadsFreshState() {
    Fixture f = new Fixture();
    f.presenter.resume();
    f.worker.next();
    f.presenter.pause();
    int count = f.ui.rendered.size();
    f.ui.drain();
    assertEquals(count, f.ui.rendered.size());
    assertTrue(f.ui.delayed.isEmpty());
    f.repository.snapshot = state(DashboardState.Phase.RUNNING);
    f.presenter.resume();
    f.worker.next();
    f.ui.drain();
    assertEquals(DashboardState.Phase.RUNNING, f.presenter.state().phase);
  }

  @Test
  public void destroyedScreenReceivesNoCommandCallback() {
    Fixture f = new Fixture();
    f.load();
    final boolean[] saved = {false};
    f.presenter.savePort("12381", () -> saved[0] = true);
    f.presenter.close();
    int count = f.ui.rendered.size();
    f.worker.next();
    f.ui.drain();
    assertFalse(saved[0]);
    assertEquals(count, f.ui.rendered.size());
    assertEquals(0, f.ui.errors);
  }

  @Test
  public void failedStartLeavesRetryableError() {
    Fixture f = new Fixture();
    f.load();
    f.repository.failStart = true;
    f.presenter.start(true);
    f.worker.next();
    f.ui.drain();
    assertEquals(DashboardState.Phase.ERROR, f.presenter.state().phase);
    assertFalse(f.presenter.state().busy());
    assertEquals(1, f.ui.errors);
  }

  @Test
  public void failedStopKeepsRunningServerVisible() {
    Fixture f = new Fixture();
    f.repository.snapshot = state(DashboardState.Phase.RUNNING);
    f.load();
    f.repository.failStop = true;
    f.presenter.stop();
    assertEquals(DashboardState.Phase.STOPPING, f.presenter.state().phase);
    f.worker.next();
    f.ui.drain();
    assertTrue(f.presenter.state().online());
    assertEquals(1, f.ui.errors);
  }

  @Test
  public void slowSourceCheckDoesNotBlockStatusAndCoalescesRepeats() {
    Fixture f = new Fixture();
    f.load();
    f.presenter.checkSources();
    f.presenter.checkSources();
    assertTrue(f.presenter.state().checkingSources);
    f.repository.snapshot = state(DashboardState.Phase.RUNNING);
    f.ui.delayed.remove(0).run();
    f.worker.next();
    f.ui.drain();
    assertTrue(f.presenter.state().online());
    assertTrue(f.presenter.state().checkingSources);
    f.sourceWorker.next();
    f.ui.drain();
    assertFalse(f.presenter.state().checkingSources);
    assertEquals(1, f.repository.checks);
  }

  @Test
  public void invalidPortDoesNotSchedulePersistence() {
    Fixture f = new Fixture();
    f.load();
    for (String value : new String[] {"", "abc", "1023", "65536", "-1"}) {
      try {
        f.presenter.savePort(value, null);
        fail("Invalid port accepted");
      } catch (IllegalArgumentException expected) {
      }
    }
    assertTrue(f.worker.queue.isEmpty());
    f.presenter.savePort(" 65535 ", null);
    assertEquals(0, f.repository.port);
    f.worker.next();
    assertEquals(65535, f.repository.port);
  }

  @Test
  public void stateDefensivelyCopiesCollections() {
    List<String> addresses = new ArrayList<>();
    addresses.add("192.168.1.20");
    DashboardState state =
        new DashboardState(
            DashboardState.Phase.RUNNING,
            Collections.emptyList(),
            addresses,
            "",
            "",
            "tv",
            12380,
            12380,
            false,
            false,
            false,
            0);
    addresses.clear();
    assertEquals("http://192.168.1.20:12380", state.url());
    try {
      state.addresses.clear();
      fail("Mutable view state");
    } catch (UnsupportedOperationException expected) {
    }
    assertEquals(state.layoutKey(), state.withPhase(DashboardState.Phase.STOPPING, "").layoutKey());
  }
}
