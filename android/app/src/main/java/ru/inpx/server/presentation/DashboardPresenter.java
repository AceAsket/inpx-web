package ru.inpx.server.presentation;

import java.util.concurrent.Executor;

/** MVP presenter. All mutable presentation state and callbacks are confined to the UI scheduler. */
public final class DashboardPresenter {
  public interface Scheduler {
    void post(Runnable task);

    void after(Runnable task, long millis);

    void cancel(Runnable task);
  }

  public interface View {
    void render(DashboardState state);

    void error(Throwable error);

    void message(String message);
  }

  public interface Result<T> {
    void accept(T value);
  }

  private interface Work<T> {
    T run() throws Exception;
  }

  private final ServerRepository repository;
  private final Executor worker, sourceWorker;
  private final Scheduler ui;
  private View view;
  private final Runnable poll = this::refresh;
  private DashboardState state = DashboardState.initial();
  private boolean active, closed, reading, commandPending, checkingSources;
  private long revision;
  private String lastReadError = "";

  public DashboardPresenter(
      ServerRepository repository,
      Executor worker,
      Executor sourceWorker,
      Scheduler ui,
      View view) {
    this.repository = repository;
    this.worker = worker;
    this.sourceWorker = sourceWorker;
    this.ui = ui;
    this.view = view;
  }

  public DashboardState state() {
    return state;
  }

  public void resume() {
    if (closed) return;
    active = true;
    view.render(state);
    refresh();
  }

  public void pause() {
    active = false;
    revision++;
    ui.cancel(poll);
  }

  public void close() {
    pause();
    closed = true;
    view = null;
  }

  private void publish(DashboardState next) {
    state = next.withSourceCheck(checkingSources);
    if (active && !closed) view.render(state);
  }

  private void refresh() {
    ui.cancel(poll);
    if (!active || closed || reading || commandPending) return;
    reading = true;
    long token = revision;
    worker.execute(
        () -> {
          DashboardState loaded = null;
          Exception failure = null;
          try {
            loaded = repository.load();
          } catch (Exception error) {
            failure = error;
          }
          final DashboardState result = loaded;
          final Exception error = failure;
          ui.post(
              () -> {
                reading = false;
                if (!active || closed) return;
                if (token != revision) {
                  refresh();
                  return;
                }
                if (error == null) {
                  lastReadError = "";
                  publish(result);
                } else {
                  publish(state.withPhase(DashboardState.Phase.ERROR, error.getMessage()));
                  if (!error.toString().equals(lastReadError)) view.error(error);
                  lastReadError = error.toString();
                }
                ui.after(poll, 2000);
              });
        });
  }

  private void command(Work<Void> action, DashboardState.Phase pending, Runnable success) {
    if (closed || commandPending) return;
    commandPending = true;
    DashboardState before = state;
    revision++;
    ui.cancel(poll);
    if (pending != null)
      publish(
          state.withPhase(
              pending,
              pending == DashboardState.Phase.STOPPING
                  ? "Завершаем работу сервера…"
                  : "Подготавливаем библиотеку. Дождитесь готовности каталога."));
    worker.execute(
        () -> {
          DashboardState loaded = null;
          Exception failure = null;
          try {
            action.run();
            loaded = repository.load();
          } catch (Exception error) {
            failure = error;
          }
          final DashboardState result = loaded;
          final Exception error = failure;
          ui.post(
              () -> {
                commandPending = false;
                if (closed) return;
                if (error == null) {
                  if (success != null) success.run();
                  publish(result);
                } else {
                  if (pending != null)
                    publish(
                        before.withPhase(
                            before.online()
                                ? DashboardState.Phase.RUNNING
                                : DashboardState.Phase.ERROR,
                            error.getMessage()));
                  view.error(error);
                }
                if (active) refresh();
              });
        });
  }

  public void start(boolean demo) {
    if (state.busy() || state.online()) return;
    command(
        () -> {
          repository.start(demo);
          return null;
        },
        DashboardState.Phase.STARTING,
        null);
  }

  public void stop() {
    if (!state.online()) return;
    command(
        () -> {
          repository.stop();
          return null;
        },
        DashboardState.Phase.STOPPING,
        null);
  }

  public void saveSource(SourceDraft source, Runnable success) {
    command(
        () -> {
          repository.saveSource(source);
          return null;
        },
        null,
        success);
  }

  public void removeSource(String id, Runnable success) {
    command(
        () -> {
          repository.removeSource(id);
          return null;
        },
        null,
        success);
  }

  public void savePort(String value, Runnable success) {
    int port = DashboardState.port(value);
    command(
        () -> {
          repository.savePort(port);
          return null;
        },
        null,
        success);
  }

  public void saveMode(String mode, Runnable success) {
    command(
        () -> {
          repository.saveMode(mode);
          return null;
        },
        null,
        success);
  }

  public void savePower(boolean awake, boolean boot, boolean battery, Runnable success) {
    command(
        () -> {
          repository.savePower(awake, boot, battery);
          return null;
        },
        null,
        success);
  }

  private <T> void read(Work<T> action, Result<T> result) {
    if (closed) return;
    worker.execute(
        () -> {
          try {
            T value = action.run();
            ui.post(
                () -> {
                  if (!closed && active) result.accept(value);
                });
          } catch (Exception error) {
            ui.post(
                () -> {
                  if (!closed && active) view.error(error);
                });
          }
        });
  }

  public void editSource(String id, Result<SourceDraft> result) {
    read(() -> repository.source(id), result);
  }

  public void power(Result<PowerSettings> result) {
    read(repository::power, result);
  }

  public void checkSources() {
    if (closed || checkingSources) return;
    checkingSources = true;
    publish(state);
    sourceWorker.execute(
        () -> {
          Exception failure = null;
          try {
            repository.checkSources();
          } catch (Exception error) {
            failure = error;
          }
          final Exception error = failure;
          ui.post(
              () -> {
                if (closed) return;
                checkingSources = false;
                publish(state);
                if (active) {
                  view.message(
                      error == null
                          ? "Проверка запрошена. Состояние обновится автоматически."
                          : "Проверка завершена. Причина недоступности показана у источника.");
                  refresh();
                }
              });
        });
  }
}
