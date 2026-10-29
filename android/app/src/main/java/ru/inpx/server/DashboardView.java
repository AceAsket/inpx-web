package ru.inpx.server;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import ru.inpx.server.presentation.DashboardState;
import ru.inpx.server.presentation.SourceInfo;

/**
 * Two native layouts sharing actions and state. Status updates never rebuild focusable controls.
 */
final class DashboardView {
  static final int BG = Color.rgb(16, 23, 34),
      SURFACE = Color.rgb(26, 38, 53),
      BORDER = Color.rgb(47, 64, 82);
  static final int TEXT = Color.rgb(242, 246, 251),
      MUTED = Color.rgb(165, 182, 201),
      MINT = Color.rgb(123, 224, 195),
      AMBER = Color.rgb(243, 200, 135);

  interface Actions {
    void toggle();

    void connect();

    void catalog();

    void demo();

    void folder();

    void smb();

    void settings();

    void power();

    void diagnostics();

    void community();

    void journal();

    void mode();

    void source(String id);
  }

  final Context context;
  final boolean tv;
  final View root;
  final Map<String, Button> controls = new LinkedHashMap<>();
  final List<Button> left = new ArrayList<>(), right = new ArrayList<>();
  final TextView badge, headline, summary, address, sourceCount, nextStep;
  private final Button primary;
  private final QrView qr;
  private final Map<String, String> sourceLabels = new LinkedHashMap<>();
  private String focusKey = "primary";

  DashboardView(
      Context context, boolean tv, String modeLabel, List<SourceInfo> sources, Actions actions) {
    this.context = context;
    this.tv = tv;
    LinearLayout screen = column();
    screen.setBackground(
        new GradientDrawable(
            GradientDrawable.Orientation.TL_BR, new int[] {BG, Color.rgb(17, 33, 43), BG}));
    screen.setPadding(dp(tv ? 36 : 20), dp(tv ? 22 : 12), dp(tv ? 36 : 20), dp(tv ? 18 : 12));
    screen.setFocusable(false);
    screen.setClipChildren(true);
    screen.setClipToPadding(false);

    LinearLayout header = row();
    header.setTag("dashboard-header");
    header.setMinimumHeight(dp(tv ? 66 : 64));
    if (tv) header.setPadding(dp(4), dp(2), dp(4), dp(2));
    header.setGravity(Gravity.CENTER_VERTICAL);
    ImageView icon = new ImageView(context);
    icon.setImageResource(R.drawable.ic_library);
    icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
    header.addView(icon, new LinearLayout.LayoutParams(dp(tv ? 44 : 40), dp(tv ? 44 : 40)));
    LinearLayout brand = column();
    brand.setPadding(dp(12), 0, 0, 0);
    brand.addView(text("INPX Server", tv ? 24 : 22, TEXT, true));
    if (tv || context.getResources().getConfiguration().screenWidthDp >= 420)
      brand.addView(text("Личная библиотека. Всегда рядом.", 12, MUTED, false));
    header.addView(brand, new LinearLayout.LayoutParams(0, -2, 1));
    Button mode = button("mode", tv ? "Пульт · " + modeLabel : "Режим", false, actions::mode);
    mode.setTextSize(13);
    mode.setContentDescription("Режим интерфейса: " + modeLabel);
    mode.setMinHeight(dp(48));
    header.addView(mode, new LinearLayout.LayoutParams(dp(tv ? 184 : 100), -2));
    screen.addView(header, new LinearLayout.LayoutParams(-1, -2));

    LinearLayout hero = card();
    badge = text("●  ПРОВЕРКА СОСТОЯНИЯ", 11, MUTED, true);
    hero.addView(badge);
    LinearLayout heroRow = row();
    heroRow.setGravity(Gravity.CENTER_VERTICAL);
    LinearLayout words = column();
    headline = text("Библиотека\nв вашей сети", tv ? 29 : 32, TEXT, true);
    headline.setLineSpacing(0, 1.04f);
    words.addView(headline);
    summary = text("Подключите книги и читайте с любого устройства дома.", 13, MUTED, false);
    summary.setPadding(0, dp(8), 0, dp(12));
    words.addView(summary);
    heroRow.addView(words, new LinearLayout.LayoutParams(0, -2, 1));
    qr = new QrView(context);
    qr.setVisibility(View.GONE);
    LinearLayout.LayoutParams qrSize =
        new LinearLayout.LayoutParams(dp(tv ? 108 : 112), dp(tv ? 108 : 112));
    qrSize.leftMargin = dp(18);
    if (tv || context.getResources().getConfiguration().screenWidthDp >= 600)
      heroRow.addView(qr, qrSize);
    hero.addView(heroRow);
    address = text("Адрес появится после запуска", tv ? 15 : 16, MINT, true);
    address.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
    hero.addView(address);
    TextView hint =
        text(
            tv ? "Сканируйте QR-код камерой телефона" : "Телефон, планшет или ридер — в одной сети",
            11,
            MUTED,
            false);
    hint.setPadding(0, dp(7), 0, 0);
    hero.addView(hint);
    nextStep = text("", 13, MUTED, false);
    nextStep.setTag("dashboard-next-step");
    nextStep.setPadding(0, dp(12), 0, 0);
    hero.addView(nextStep);

    primary = button("primary", "Запустить сервер", true, actions::toggle);
    left.add(primary);
    Button connection = button("connection", "Адрес и QR-код", false, actions::connect);
    left.add(connection);
    Button catalog = button("catalog", "Открыть каталог", false, actions::catalog);
    left.add(catalog);
    Button demo = button("demo", "Попробовать демо-библиотеку", false, actions::demo);
    left.add(demo);

    LinearLayout library = card();
    LinearLayout sectionHeader = row();
    TextView title = text("Источники книг", tv ? 20 : 21, TEXT, true);
    sectionHeader.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
    sourceCount =
        text(String.format(java.util.Locale.ROOT, "%02d", sources.size()), 18, MINT, true);
    sectionHeader.addView(sourceCount);
    library.addView(sectionHeader);
    TextView explanation = text("Папка с INPX и архивами или библиотека на NAS.", 13, MUTED, false);
    explanation.setPadding(0, dp(6), 0, dp(12));
    library.addView(explanation);
    Button folder = button("folder", "＋  Папка на SD / USB", false, actions::folder);
    right.add(folder);
    addControl(library, folder);
    Button smb = button("smb", "＋  Сетевая папка SMB", false, actions::smb);
    right.add(smb);
    addControl(library, smb);
    if (sources.size() == 0) {
      TextView empty =
          text("Пока нет источников\nДобавьте библиотеку или начните с демо.", 13, MUTED, false);
      empty.setPadding(dp(4), dp(16), dp(4), dp(8));
      library.addView(empty);
    }
    for (int i = 0; i < sources.size(); i++) {
      SourceInfo source = sources.get(i);
      String kind = source.kind.equals("smb") ? "SMB · " + source.location : "SD / USB · Папка";
      Button entry =
          button(
              "source:" + source.id,
              source.name + "\n" + kind + "   ›",
              false,
              () -> actions.source(source.id));
      entry.setTextSize(14);
      entry.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
      entry.setMaxLines(3);
      sourceLabels.put(source.id, source.name + "\n" + kind);
      right.add(entry);
      addControl(library, entry, 88);
    }
    TextView sourceHint = text("После смены источников перезапустите сервер.", 11, MUTED, false);
    sourceHint.setPadding(0, dp(10), 0, 0);
    library.addView(sourceHint);

    Button diagnostics = button("diagnostics", "Состояние источников", false, actions::diagnostics);
    right.add(diagnostics);
    addControl(library, diagnostics);
    Button power = button("power", "Фоновая работа", false, actions::power);
    right.add(power);
    addControl(library, power);
    LinearLayout options = row();
    Button settings = button("settings", "Настройки", false, actions::settings);
    right.add(settings);
    Button journal = button("journal", "Журнал", false, actions::journal);
    right.add(journal);
    Button community = button("community", "Telegram", false, actions::community);
    community.setContentDescription("Сообщество INPX Web в Telegram");
    right.add(community);
    community.setMinHeight(dp(52));
    settings.setMinHeight(dp(52));
    journal.setMinHeight(dp(52));
    LinearLayout.LayoutParams a = new LinearLayout.LayoutParams(0, -2, 1);
    a.rightMargin = dp(6);
    options.addView(settings, a);
    LinearLayout.LayoutParams b = new LinearLayout.LayoutParams(0, -2, 1);
    b.leftMargin = dp(6);
    options.addView(journal, b);
    b.rightMargin = dp(6);
    LinearLayout.LayoutParams c = new LinearLayout.LayoutParams(0, -2, 1);
    c.leftMargin = dp(6);
    options.addView(community, c);

    if (tv && context.getResources().getConfiguration().screenWidthDp >= 720) {
      LinearLayout columns = row();
      columns.setGravity(Gravity.TOP);
      columns.setClipChildren(true);
      LinearLayout main = column();
      main.addView(hero);
      for (Button control : left) addControl(main, control);
      LinearLayout side = column();
      side.addView(library);
      LinearLayout.LayoutParams optionSize = new LinearLayout.LayoutParams(-1, -2);
      optionSize.topMargin = dp(12);
      side.addView(options, optionSize);
      LinearLayout.LayoutParams leftSize = new LinearLayout.LayoutParams(0, -1, 1);
      leftSize.rightMargin = dp(12);
      LinearLayout.LayoutParams rightSize = new LinearLayout.LayoutParams(0, -1, 1);
      rightSize.leftMargin = dp(12);
      columns.addView(scroll(main), leftSize);
      columns.addView(scroll(side), rightSize);
      screen.addView(columns, new LinearLayout.LayoutParams(-1, 0, 1));
      TextView help =
          text(
              "↑ ↓ ← →  Выбор     OK  Открыть     Назад  Вернуться                         ANDROID"
                  + " TV · 0.6",
              11,
              MUTED,
              false);
      help.setPadding(0, dp(12), 0, 0);
      help.setTag("dashboard-footer");
      screen.addView(help);
      root = screen;
      wireTvFocus(mode);
    } else {
      LinearLayout content = column();
      content.addView(hero);
      addControl(content, primary, 56);
      LinearLayout quick = row();
      connection.setMinHeight(dp(52));
      catalog.setMinHeight(dp(52));
      LinearLayout.LayoutParams q1 = new LinearLayout.LayoutParams(0, -2, 1);
      q1.rightMargin = dp(5);
      quick.addView(connection, q1);
      LinearLayout.LayoutParams q2 = new LinearLayout.LayoutParams(0, -2, 1);
      q2.leftMargin = dp(5);
      quick.addView(catalog, q2);
      LinearLayout.LayoutParams q = new LinearLayout.LayoutParams(-1, -2);
      q.topMargin = dp(10);
      content.addView(quick, q);
      LinearLayout.LayoutParams lib = new LinearLayout.LayoutParams(-1, -2);
      lib.topMargin = dp(22);
      content.addView(library, lib);
      addControl(content, demo);
      LinearLayout.LayoutParams opt = new LinearLayout.LayoutParams(-1, -2);
      opt.topMargin = dp(10);
      content.addView(options, opt);
      TextView footer = text("INPX SERVER  /  ANDROID 9+  /  0.6", 11, MUTED, false);
      footer.setTag("dashboard-footer");
      footer.setGravity(Gravity.CENTER);
      footer.setPadding(0, dp(24), 0, dp(10));
      content.addView(footer);
      screen.addView(content);
      FrameLayout centered = new FrameLayout(context);
      centered.setBackgroundColor(BG);
      int width = Math.min(context.getResources().getConfiguration().screenWidthDp, 840);
      FrameLayout.LayoutParams centeredSize =
          new FrameLayout.LayoutParams(dp(width), -2, Gravity.TOP | Gravity.CENTER_HORIZONTAL);
      centered.addView(screen, centeredSize);
      root = scroll(centered);
      if (tv) wireTvFocus(mode);
    }
  }

  private View scroll(View content) {
    ScrollView scroll = new ScrollView(context);
    scroll.setFillViewport(false);
    scroll.setClipToPadding(false);
    scroll.setClipChildren(false);
    if (tv) scroll.setPadding(dp(6), dp(6), dp(6), dp(6));
    scroll.setVerticalScrollBarEnabled(false);
    scroll.setFocusable(false);
    scroll.addView(content);
    // Clip the complete viewport while allowing focus scaling inside its reserved padding.
    FrameLayout viewport = new FrameLayout(context);
    viewport.setClipChildren(true);
    viewport.setClipToPadding(false);
    viewport.addView(scroll, new FrameLayout.LayoutParams(-1, -1));
    return viewport;
  }

  LinearLayout column() {
    LinearLayout l = new LinearLayout(context);
    l.setOrientation(LinearLayout.VERTICAL);
    l.setClipChildren(false);
    l.setClipToPadding(false);
    return l;
  }

  LinearLayout row() {
    LinearLayout l = new LinearLayout(context);
    l.setOrientation(LinearLayout.HORIZONTAL);
    l.setClipChildren(false);
    l.setClipToPadding(false);
    return l;
  }

  LinearLayout card() {
    LinearLayout l = column();
    l.setPadding(dp(tv ? 20 : 22), dp(tv ? 17 : 22), dp(tv ? 20 : 22), dp(tv ? 17 : 22));
    l.setBackground(shape(SURFACE, BORDER, 1, 22));
    return l;
  }

  int dp(float n) {
    return Math.round(n * context.getResources().getDisplayMetrics().density);
  }

  TextView text(String value, float size, int color, boolean bold) {
    TextView t = new TextView(context);
    t.setText(value);
    t.setTextSize(size);
    t.setTextColor(color);
    if (bold) t.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
    t.setFocusable(false);
    return t;
  }

  GradientDrawable shape(int color, int border, int stroke, int radius) {
    GradientDrawable g = new GradientDrawable();
    g.setColor(color);
    g.setCornerRadius(dp(radius));
    if (stroke > 0) g.setStroke(dp(stroke), border);
    return g;
  }

  Button button(String key, String label, boolean filled, Runnable action) {
    Button v = new Button(context);
    v.setId(View.generateViewId());
    v.setTag(key);
    v.setAllCaps(false);
    v.setText(label);
    v.setTextSize(tv ? 15 : 14);
    v.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
    v.setMinHeight(0);
    v.setMinimumHeight(0);
    v.setMinWidth(0);
    v.setMinimumWidth(0);
    v.setPadding(dp(16), dp(4), dp(16), dp(4));
    v.setMaxLines(2);
    v.setElevation(0);
    v.setStateListAnimator(null);
    StateListDrawable states = new StateListDrawable();
    states.addState(
        new int[] {android.R.attr.state_pressed},
        shape(filled ? Color.rgb(157, 242, 215) : Color.rgb(49, 79, 79), MINT, 2, 14));
    states.addState(
        new int[] {android.R.attr.state_focused},
        shape(filled ? MINT : Color.rgb(36, 65, 66), Color.WHITE, 3, 14));
    states.addState(
        new int[] {}, shape(filled ? MINT : Color.rgb(32, 47, 64), filled ? MINT : BORDER, 1, 14));
    v.setBackground(states);
    v.setTextColor(filled ? BG : TEXT);
    v.setFocusable(true);
    v.setFocusableInTouchMode(tv);
    v.setOnClickListener(w -> action.run());
    v.setOnFocusChangeListener(
        (w, focused) -> {
          if (focused) focusKey = key;
          if (tv) {
            w.animate()
                .scaleX(focused ? 1.015f : 1)
                .scaleY(focused ? 1.015f : 1)
                .setDuration(120)
                .start();
            w.setTranslationZ(focused ? dp(4) : 0);
          }
        });
    controls.put(key, v);
    return v;
  }

  private void addControl(LinearLayout parent, Button control) {
    addControl(parent, control, 52);
  }

  private void addControl(LinearLayout parent, Button control, int height) {
    control.setMinHeight(dp(height));
    LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2);
    p.topMargin = dp(10);
    parent.addView(control, p);
  }

  private void wireTvFocus(Button mode) {
    for (List<Button> group : java.util.Arrays.asList(left, right))
      for (int i = 0; i < group.size(); i++) {
        Button v = group.get(i);
        v.setNextFocusUpId(i == 0 ? mode.getId() : group.get(i - 1).getId());
        v.setNextFocusDownId(i + 1 < group.size() ? group.get(i + 1).getId() : v.getId());
        List<Button> other = group == left ? right : left;
        int id = other.get(Math.min(i, other.size() - 1)).getId();
        if (group == left) v.setNextFocusRightId(id);
        else v.setNextFocusLeftId(id);
      }
    mode.setNextFocusDownId(right.get(0).getId());
    mode.setNextFocusLeftId(left.get(0).getId());
    Button settings = controls.get("settings"),
        journal = controls.get("journal"),
        community = controls.get("community");
    settings.setNextFocusRightId(journal.getId());
    journal.setNextFocusLeftId(settings.getId());
    journal.setNextFocusRightId(community.getId());
    community.setNextFocusLeftId(journal.getId());
    community.setNextFocusRightId(community.getId());
    for (Button option : new Button[] {settings, journal, community}) {
      option.setNextFocusUpId(controls.get("power").getId());
      option.setNextFocusDownId(option.getId());
    }
  }

  void focus(String key) {
    Button v = controls.get(key);
    if (v == null) v = primary;
    if (tv) v.requestFocus();
  }

  String focusKey() {
    return focusKey;
  }

  void update(DashboardState state) {
    boolean online = state.online(), busy = state.busy(), empty = state.sources.isEmpty();
    for (SourceInfo source : state.sources) {
      Button button = controls.get("source:" + source.id);
      if (button == null) continue;
      String label = source.label;
      if ((online || busy) && source.online && source.restartRequired)
        label = "Доступен · перезапустите сервер";
      button.setText(sourceLabels.get(source.id) + "\n" + label + "   ›");
      button.setContentDescription(sourceLabels.get(source.id).replace('\n', ' ') + ". " + label);
    }
    badge.setText(
        online
            ? "●  СЕРВЕР В СЕТИ"
            : state.phase == DashboardState.Phase.STOPPING
                ? "●  ЗАВЕРШЕНИЕ РАБОТЫ"
                : busy
                    ? "●  ПОДГОТОВКА БИБЛИОТЕКИ"
                    : state.phase == DashboardState.Phase.ERROR
                        ? "!  НУЖНО ВНИМАНИЕ"
                        : empty ? "1 / 3  ·  ПОДКЛЮЧИТЕ КНИГИ" : "2 / 3  ·  ВСЁ ГОТОВО К ЗАПУСКУ");
    badge.setTextColor(
        online ? MINT : busy || state.phase == DashboardState.Phase.ERROR ? AMBER : MUTED);
    headline.setText(
        online
            ? "Всё готово\nк чтению"
            : state.phase == DashboardState.Phase.STOPPING
                ? "Завершаем\nработу"
                : busy
                    ? "Готовим вашу\nбиблиотеку"
                    : empty ? "Начните со\nсвоих книг" : "Библиотека\nв вашей сети");
    int count = state.sources.size();
    int digit = count % 10, lastTwo = count % 100;
    String noun =
        digit == 1 && lastTwo != 11
            ? " источник"
            : digit >= 2 && digit <= 4 && (lastTwo < 12 || lastTwo > 14)
                ? " источника"
                : " источников";
    summary.setText(
        online
            ? (state.demo
                ? "Демо-библиотека · две книги для знакомства"
                : count + noun + " · Каталог и OPDS в домашней сети")
            : busy || state.phase == DashboardState.Phase.ERROR
                ? state.detail
                : empty
                    ? "Подключите папку с INPX и архивами или библиотеку на NAS."
                    : "Настройки сохранены. Запустите сервер и откройте каталог.");
    address.setText(
        online
            ? state.url().isEmpty() ? "Подключите Wi-Fi или Ethernet" : state.url()
            : "Адрес появится после запуска");
    nextStep.setText(
        state.restartRequired
            ? "Есть изменения. Остановите и запустите сервер, чтобы применить их."
            : online
                ? "3 / 3  ·  Откройте каталог здесь или сканируйте QR-код телефоном."
                : busy
                    ? "Экран можно выключить. Состояние обновится автоматически."
                    : empty
                        ? "Добавить библиотеку → Запустить сервер → Открыть каталог"
                        : "Следующий шаг — нажмите «Запустить сервер».");
    nextStep.setTextColor(state.restartRequired ? AMBER : MUTED);
    primary.setText(
        online
            ? "Остановить сервер"
            : state.phase == DashboardState.Phase.LOADING
                ? "Читаем настройки…"
                : state.phase == DashboardState.Phase.STOPPING
                    ? "Останавливаем сервер…"
                    : busy
                        ? "Запускаем сервер…"
                        : empty ? "Добавить библиотеку" : "Запустить сервер");
    primary.setAlpha(busy ? .65f : 1f);
    controls.get("catalog").setAlpha(online ? 1f : .6f);
    controls
        .get("demo")
        .setText(
            online && state.demo
                ? "Сейчас работает демо-библиотека"
                : "Попробовать демо-библиотеку");
    if (online && !state.url().isEmpty()) {
      qr.setUrl(state.url());
      qr.setVisibility(View.VISIBLE);
    } else qr.setVisibility(View.GONE);
  }
}
