package ru.inpx.server;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.res.ColorStateList;
import android.graphics.drawable.StateListDrawable;
import android.text.InputType;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import java.util.function.Consumer;
import java.util.function.Supplier;
import ru.inpx.server.presentation.*;

/**
 * Shared dialog styling, input accessibility and remote focus. Contains no persistence or network
 * I/O.
 */
class DialogUi {
  protected final Activity activity;
  protected final boolean tv;
  protected final DashboardView dashboard;
  protected final DashboardPresenter presenter;
  protected final Supplier<DashboardState> current;
  protected final Consumer<String> focus;

  DialogUi(
      Activity activity,
      boolean tv,
      DashboardView dashboard,
      DashboardPresenter presenter,
      Supplier<DashboardState> current,
      Consumer<String> focus) {
    this.activity = activity;
    this.tv = tv;
    this.dashboard = dashboard;
    this.presenter = presenter;
    this.current = current;
    this.focus = focus;
  }

  DialogUi(DialogUi base) {
    this(base.activity, base.tv, base.dashboard, base.presenter, base.current, base.focus);
  }

  protected int dp(float n) {
    return Math.round(n * activity.getResources().getDisplayMetrics().density);
  }

  protected LinearLayout form() {
    LinearLayout l = new LinearLayout(activity);
    l.setOrientation(LinearLayout.VERTICAL);
    l.setPadding(dp(24), dp(8), dp(24), dp(16));
    return l;
  }

  protected TextView text(String value, float size, int color) {
    TextView t = new TextView(activity);
    t.setText(value);
    t.setTextSize(size);
    t.setTextColor(color);
    t.setPadding(0, dp(6), 0, dp(10));
    return t;
  }

  protected EditText field(String hint, boolean password) {
    EditText f = new EditText(activity);
    f.setId(View.generateViewId());
    f.setHint(hint);
    f.setTextSize(tv ? 17 : 16);
    f.setTextColor(DashboardView.TEXT);
    f.setHintTextColor(DashboardView.MUTED);
    f.setSingleLine(true);
    f.setMinHeight(dp(tv ? 56 : 50));
    f.setInputType(
        InputType.TYPE_CLASS_TEXT
            | (password
                ? InputType.TYPE_TEXT_VARIATION_PASSWORD
                : InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS));
    f.setShowSoftInputOnFocus(!tv);
    f.setOnKeyListener(
        (v, key, event) -> {
          if (!tv) return false;
          if (key == KeyEvent.KEYCODE_DPAD_CENTER || key == KeyEvent.KEYCODE_ENTER) {
            if (event.getAction() == KeyEvent.ACTION_UP)
              activity
                  .getSystemService(InputMethodManager.class)
                  .showSoftInput(f, InputMethodManager.SHOW_IMPLICIT);
            return true;
          }
          if ((key == KeyEvent.KEYCODE_DPAD_DOWN || key == KeyEvent.KEYCODE_DPAD_UP)
              && event.getAction() == KeyEvent.ACTION_DOWN) {
            View next =
                f.focusSearch(key == KeyEvent.KEYCODE_DPAD_DOWN ? View.FOCUS_DOWN : View.FOCUS_UP);
            if (next != null && next != f) {
              next.requestFocus();
              return true;
            }
          }
          return false;
        });
    return f;
  }

  protected void fieldRow(LinearLayout form, String title, EditText field) {
    TextView label = text(title, 12, DashboardView.MUTED);
    label.setPadding(0, dp(8), 0, 0);
    label.setLabelFor(field.getId());
    form.addView(label);
    form.addView(field);
  }

  protected void wireFields(EditText[] fields, AlertDialog dialog) {
    Button positive = dialog.getButton(-1), negative = dialog.getButton(-2);
    positive.setId(View.generateViewId());
    negative.setId(View.generateViewId());
    for (int i = 0; i < fields.length; i++) {
      final int next = i + 1;
      EditText f = fields[i];
      f.setNextFocusDownId(i + 1 < fields.length ? fields[i + 1].getId() : positive.getId());
      f.setNextFocusForwardId(i + 1 < fields.length ? fields[i + 1].getId() : positive.getId());
      f.setNextFocusUpId(i == 0 ? negative.getId() : fields[i - 1].getId());
      f.setImeOptions(
          i + 1 < fields.length ? EditorInfo.IME_ACTION_NEXT : EditorInfo.IME_ACTION_DONE);
      f.setOnEditorActionListener(
          (v, action, event) -> {
            if (action == EditorInfo.IME_ACTION_NEXT || action == EditorInfo.IME_ACTION_DONE) {
              if (next < fields.length) fields[next].requestFocus();
              else {
                activity
                    .getSystemService(InputMethodManager.class)
                    .hideSoftInputFromWindow(f.getWindowToken(), 0);
                positive.requestFocus();
              }
              return true;
            }
            return false;
          });
    }
    positive.setNextFocusUpId(fields[fields.length - 1].getId());
    negative.setNextFocusUpId(fields[fields.length - 1].getId());
    if (tv) fields[0].requestFocus();
  }

  protected void show(AlertDialog dialog) {
    dialog.show();
    dialog
        .getWindow()
        .setSoftInputMode(
            WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN
                | WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    dialog
        .getWindow()
        .setBackgroundDrawable(dashboard.shape(DashboardView.SURFACE, DashboardView.BORDER, 1, 20));
    int available = activity.getResources().getConfiguration().screenWidthDp;
    dialog
        .getWindow()
        .setLayout(
            dp(Math.min(tv ? 650 : 560, available - 40)), WindowManager.LayoutParams.WRAP_CONTENT);
    for (int id : new int[] {-1, -2, -3}) {
      Button button = dialog.getButton(id);
      if (button == null) continue;
      StateListDrawable bg = new StateListDrawable();
      bg.addState(
          new int[] {android.R.attr.state_focused},
          dashboard.shape(DashboardView.MINT, android.graphics.Color.WHITE, 2, 10));
      bg.addState(
          new int[] {}, dashboard.shape(DashboardView.SURFACE, DashboardView.BORDER, 1, 10));
      button.setBackground(bg);
      button.setMinHeight(dp(48));
      button.setPadding(dp(14), dp(4), dp(14), dp(4));
      button.setAllCaps(false);
      button.setTextColor(
          new ColorStateList(
              new int[][] {new int[] {android.R.attr.state_focused}, new int[] {}},
              new int[] {DashboardView.BG, DashboardView.MINT}));
    }
    if (dialog.getListView() != null)
      dialog
          .getListView()
          .setSelector(
              dashboard.shape(android.graphics.Color.rgb(39, 77, 72), DashboardView.MINT, 2, 10));
  }

  protected void error(Throwable e) {
    if (!activity.isFinishing() && !activity.isDestroyed())
      show(
          new AlertDialog.Builder(activity)
              .setTitle("INPX Server")
              .setMessage(e.getMessage() == null ? "Не удалось выполнить действие" : e.getMessage())
              .setPositiveButton("Понятно", null)
              .create());
  }

  protected void toast(String value) {
    Toast.makeText(activity, value, Toast.LENGTH_LONG).show();
  }
}
