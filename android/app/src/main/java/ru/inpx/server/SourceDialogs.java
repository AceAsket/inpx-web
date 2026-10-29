package ru.inpx.server;

import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.UUID;
import ru.inpx.server.presentation.DashboardState;
import ru.inpx.server.presentation.SourceDraft;
import ru.inpx.server.presentation.SourceInfo;

/** Source forms and diagnostics. Stable IDs replace mutable list positions in all commands. */
final class SourceDialogs extends DialogUi {
  private final Runnable chooseFolder, demo;
  private TextView diagnosticText;
  private Button diagnosticCheck;

  SourceDialogs(DialogUi base, Runnable chooseFolder, Runnable demo) {
    super(base);
    this.chooseFolder = chooseFolder;
    this.demo = demo;
  }

  void add() {
    AlertDialog dialog =
        new AlertDialog.Builder(activity)
            .setTitle("С чего начать библиотеку")
            .setItems(
                new String[] {
                  "Папка на устройстве · SD / USB",
                  "Сетевая папка · SMB / NAS",
                  "Попробовать демо без своих книг"
                },
                (d, item) -> {
                  if (item == 0) chooseFolder.run();
                  else if (item == 1) smb(null);
                  else demo.run();
                })
            .setNegativeButton("Назад", null)
            .create();
    show(dialog);
    if (tv) dialog.getListView().requestFocus();
  }

  void tree(String uri) {
    EditText name = field("Название библиотеки", false);
    name.setText("Библиотека " + (current.get().sources.size() + 1));
    LinearLayout form = form();
    fieldRow(form, "Как назвать источник", name);
    AlertDialog dialog =
        new AlertDialog.Builder(activity)
            .setTitle("Папка подключена")
            .setView(form)
            .setPositiveButton("Добавить", null)
            .setNegativeButton("Отмена", null)
            .create();
    show(dialog);
    wireFields(new EditText[] {name}, dialog);
    final String id = UUID.randomUUID().toString();
    dialog
        .getButton(-1)
        .setOnClickListener(
            v -> {
              String title = name.getText().toString().trim();
              if (title.isEmpty()) {
                name.setError("Укажите название");
                name.requestFocus();
                return;
              }
              save(SourceDraft.tree(id, title, uri), dialog);
            });
  }

  private void save(SourceDraft source, AlertDialog dialog) {
    focus.accept("source:" + source.id);
    presenter.saveSource(
        source,
        () -> {
          dialog.dismiss();
          toast(
              current.get().online() || current.get().busy()
                  ? "Источник сохранён. Перезапустите сервер для применения."
                  : "Библиотека сохранена. Можно запускать сервер.");
        });
  }

  void smb(SourceDraft previous) {
    LinearLayout form = form();
    String[] labels = {
      "Название",
      "Сервер",
      "Общая папка",
      "Подпапка · необязательно",
      "Логин",
      "Пароль",
      "Домен · необязательно"
    };
    String[] hints = {
      "Домашняя библиотека",
      "192.168.1.10 или nas.local",
      "books",
      "Папка внутри общей папки",
      "Имя пользователя",
      "Пароль SMB",
      "WORKGROUP"
    };
    String[] values =
        previous == null
            ? new String[] {"", "", "", "", "", "", ""}
            : new String[] {
              previous.name,
              previous.host,
              previous.share,
              previous.folder,
              previous.user,
              previous.password,
              previous.domain
            };
    EditText[] fields = new EditText[labels.length];
    for (int i = 0; i < labels.length; i++) {
      fields[i] = field(hints[i], i == 5);
      fields[i].setText(values[i]);
      fieldRow(form, labels[i], fields[i]);
    }
    form.addView(
        text(
            "Учётные данные сохраняются с шифрованием. Подключение — SMB2 / SMB3.",
            12,
            DashboardView.MUTED));
    ScrollView scroll = new ScrollView(activity);
    scroll.addView(form);
    AlertDialog dialog =
        new AlertDialog.Builder(activity)
            .setTitle(previous == null ? "Библиотека на NAS" : "Настройки SMB")
            .setView(scroll)
            .setPositiveButton(previous == null ? "Подключить" : "Сохранить", null)
            .setNegativeButton("Отмена", null)
            .create();
    show(dialog);
    wireFields(fields, dialog);
    final String id = previous == null ? UUID.randomUUID().toString() : previous.id;
    dialog
        .getButton(-1)
        .setOnClickListener(
            v -> {
              String[] data = new String[fields.length];
              for (int i = 0; i < fields.length; i++)
                data[i] =
                    i == 5 ? fields[i].getText().toString() : fields[i].getText().toString().trim();
              for (int required : new int[] {1, 2}) {
                if (data[required].isEmpty()) {
                  fields[required].setError(
                      required == 1 ? "Укажите сервер" : "Укажите общую папку");
                  fields[required].requestFocus();
                  return;
                }
              }
              if (data[0].isEmpty()) data[0] = data[1] + "/" + data[2];
              save(
                  new SourceDraft(
                      id, "smb", data[0], "", data[1], data[2], data[3], data[4], data[5], data[6]),
                  dialog);
            });
  }

  void open(String id) {
    presenter.editSource(id, this::sourceMenu);
  }

  private void sourceMenu(SourceDraft source) {
    AlertDialog dialog =
        new AlertDialog.Builder(activity)
            .setTitle(source.name)
            .setItems(
                new String[] {
                  source.kind.equals("smb") ? "Настроить подключение" : "Переименовать",
                  "Удалить источник"
                },
                (d, item) -> {
                  if (item == 0) {
                    if (source.kind.equals("smb")) smb(source);
                    else rename(source);
                  } else {
                    AlertDialog confirm =
                        new AlertDialog.Builder(activity)
                            .setTitle("Удалить источник?")
                            .setMessage(
                                "«"
                                    + source.name
                                    + "» будет удалён из настроек. Книги останутся на месте.")
                            .setPositiveButton(
                                "Удалить",
                                (a, b) -> {
                                  focus.accept("folder");
                                  presenter.removeSource(
                                      source.id, () -> toast("Источник удалён из приложения"));
                                })
                            .setNegativeButton("Отмена", null)
                            .create();
                    show(confirm);
                    if (tv) confirm.getButton(-2).requestFocus();
                  }
                })
            .setNegativeButton("Назад", null)
            .create();
    show(dialog);
  }

  private void rename(SourceDraft source) {
    EditText name = field("Название библиотеки", false);
    name.setText(source.name);
    LinearLayout form = form();
    fieldRow(form, "Название", name);
    AlertDialog dialog =
        new AlertDialog.Builder(activity)
            .setTitle("Название источника")
            .setView(form)
            .setPositiveButton("Сохранить", null)
            .setNegativeButton("Отмена", null)
            .create();
    show(dialog);
    wireFields(new EditText[] {name}, dialog);
    dialog
        .getButton(-1)
        .setOnClickListener(
            v -> {
              String title = name.getText().toString().trim();
              if (title.isEmpty()) {
                name.setError("Укажите название");
                name.requestFocus();
                return;
              }
              save(source.renamed(title), dialog);
            });
  }

  void diagnostics() {
    LinearLayout content = form();
    content.addView(
        text(
            "Сохранённый каталог доступен при временной потере накопителя или NAS. Для загрузки"
                + " книг вне кэша нужен сам источник.",
            13,
            DashboardView.MUTED));
    diagnosticText = text(report(), tv ? 16 : 15, DashboardView.TEXT);
    diagnosticText.setTag("diagnostic-report");
    content.addView(diagnosticText);
    ScrollView scroll = new ScrollView(activity);
    scroll.addView(content);
    scroll.setFocusable(tv);
    AlertDialog dialog =
        new AlertDialog.Builder(activity)
            .setTitle("Состояние источников")
            .setView(scroll)
            .setPositiveButton("Проверить сейчас", null)
            .setNegativeButton("Закрыть", null)
            .setNeutralButton(
                "Скопировать отчёт",
                (d, w) -> {
                  activity
                      .getSystemService(ClipboardManager.class)
                      .setPrimaryClip(
                          ClipData.newPlainText("INPX: состояние источников", report()));
                  toast("Отчёт скопирован");
                })
            .create();
    show(dialog);
    diagnosticCheck = dialog.getButton(-1);
    diagnosticCheck.setFocusableInTouchMode(tv);
    diagnosticCheck.setOnClickListener(v -> presenter.checkSources());
    dialog.setOnDismissListener(
        d -> {
          diagnosticText = null;
          diagnosticCheck = null;
        });
    updateDiagnostics();
    if (tv) FocusRequests.whenReady(diagnosticCheck, diagnosticCheck::requestFocus);
  }

  void updateDiagnostics() {
    if (diagnosticText != null) diagnosticText.setText(report());
    if (diagnosticCheck != null)
      diagnosticCheck.setText(
          current.get().checkingSources ? "Проверяем источники…" : "Проверить сейчас");
  }

  private String time(long value) {
    return value > 0
        ? java.text.DateFormat.getDateTimeInstance(
                java.text.DateFormat.SHORT, java.text.DateFormat.SHORT)
            .format(new java.util.Date(value))
        : "ещё не было";
  }

  private String report() {
    DashboardState state = current.get();
    StringBuilder text =
        new StringBuilder("Сервер: ")
            .append(state.online() ? "работает" : state.busy() ? "подготовка" : "остановлен")
            .append("\nСвободно для данных приложения: ")
            .append(android.text.format.Formatter.formatFileSize(activity, state.freeBytes));
    if (state.checkingSources) text.append("\nПроверка источников…");
    if (state.sources.isEmpty()) text.append("\n\nИсточники пока не добавлены.");
    for (SourceInfo source : state.sources) {
      text.append("\n\n")
          .append(source.name)
          .append(" · ")
          .append(source.kind.equals("smb") ? "SMB" : "SD / USB")
          .append("\n")
          .append(source.label);
      if (!source.message.isEmpty()) text.append("\n").append(source.message);
      if (source.cachedIndex)
        text.append("\nINPX сохранён: ")
            .append(android.text.format.Formatter.formatFileSize(activity, source.indexBytes))
            .append(" · ")
            .append(time(source.indexUpdatedAt));
      text.append("\nПроверка: ")
          .append(time(source.checkedAt))
          .append("\nУспешный доступ: ")
          .append(time(source.lastSuccess));
      if ((state.online() || state.busy()) && source.online && source.restartRequired)
        text.append("\nПерезапустите сервер, чтобы включить источник в каталог.");
    }
    return text.toString();
  }
}
