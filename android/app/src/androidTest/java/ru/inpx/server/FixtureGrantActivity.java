package ru.inpx.server;

/**
 * Grants the instrumented app access to generated test documents, using the provider owner's UID.
 */
public final class FixtureGrantActivity extends android.app.Activity {
  @Override
  public void onCreate(android.os.Bundle state) {
    super.onCreate(state);
    grantUriPermission(
        getPackageName().substring(0, getPackageName().length() - 5),
        android.net.Uri.parse("content://" + getPackageName() + ".storage"),
        android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION
            | android.content.Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
    finish();
  }
}
