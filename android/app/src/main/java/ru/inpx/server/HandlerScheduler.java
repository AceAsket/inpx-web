package ru.inpx.server;

import android.os.Handler;
import ru.inpx.server.presentation.DashboardPresenter;

/** Main-loop adapter without retaining an Activity through an anonymous inner class. */
final class HandlerScheduler implements DashboardPresenter.Scheduler {
  private final Handler handler;

  HandlerScheduler(Handler handler) {
    this.handler = handler;
  }

  public void post(Runnable task) {
    handler.post(task);
  }

  public void after(Runnable task, long millis) {
    handler.postDelayed(task, millis);
  }

  public void cancel(Runnable task) {
    handler.removeCallbacks(task);
  }
}
