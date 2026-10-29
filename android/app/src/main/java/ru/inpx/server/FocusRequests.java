package ru.inpx.server;

import android.view.View;
import android.view.ViewTreeObserver;

/**
 * Requests remote focus after attachment, window activation and layout, rather than racing them.
 */
final class FocusRequests
    implements ViewTreeObserver.OnGlobalLayoutListener,
        ViewTreeObserver.OnWindowFocusChangeListener,
        View.OnAttachStateChangeListener {
  private final View scope;
  private final Runnable action;
  private boolean finished, posted;

  private FocusRequests(View scope, Runnable action) {
    this.scope = scope;
    this.action = action;
  }

  static void whenReady(View scope, Runnable action) {
    FocusRequests request = new FocusRequests(scope, action);
    scope.addOnAttachStateChangeListener(request);
    scope.getViewTreeObserver().addOnGlobalLayoutListener(request);
    scope.getViewTreeObserver().addOnWindowFocusChangeListener(request);
    request.schedule();
  }

  private void schedule() {
    if (finished
        || posted
        || !scope.isAttachedToWindow()
        || !scope.hasWindowFocus()
        || scope.getWidth() == 0) return;
    posted = true;
    scope.post(
        () -> {
          posted = false;
          if (finished || !scope.isAttachedToWindow() || !scope.hasWindowFocus()) return;
          finish();
          action.run();
        });
  }

  private void finish() {
    finished = true;
    scope.removeOnAttachStateChangeListener(this);
    ViewTreeObserver observer = scope.getViewTreeObserver();
    if (observer.isAlive()) {
      observer.removeOnGlobalLayoutListener(this);
      observer.removeOnWindowFocusChangeListener(this);
    }
  }

  public void onGlobalLayout() {
    schedule();
  }

  public void onWindowFocusChanged(boolean hasFocus) {
    if (hasFocus) schedule();
  }

  public void onViewAttachedToWindow(View view) {
    schedule();
  }

  public void onViewDetachedFromWindow(View view) {
    finish();
  }
}
