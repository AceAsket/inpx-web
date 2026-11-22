package ru.inpx.server;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.view.View;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;
import java.util.Collections;

/** Crisp at any TV density, with a full white quiet zone and no filtering. */
final class QrView extends View {
  private final Paint paint = new Paint();
  private BitMatrix matrix;
  private String url = "";

  QrView(Context context) {
    super(context);
    setFocusable(false);
  }

  void setUrl(String value) {
    if (value.equals(url)) return;
    try {
      matrix =
          new QRCodeWriter()
              .encode(
                  value,
                  BarcodeFormat.QR_CODE,
                  0,
                  0,
                  Collections.singletonMap(EncodeHintType.MARGIN, 4));
      url = value;
      setContentDescription("QR-код адреса сервера: " + value);
      invalidate();
    } catch (Exception ignored) {
      matrix = null;
      invalidate();
    }
  }

  @Override
  protected void onDraw(Canvas canvas) {
    super.onDraw(canvas);
    paint.setColor(Color.WHITE);
    float radius = 12 * getResources().getDisplayMetrics().density;
    canvas.drawRoundRect(0, 0, getWidth(), getHeight(), radius, radius, paint);
    if (matrix == null) return;
    int cell = Math.max(1, (Math.min(getWidth(), getHeight()) - 12) / matrix.getWidth());
    float x = (getWidth() - cell * matrix.getWidth()) / 2f,
        y = (getHeight() - cell * matrix.getHeight()) / 2f;
    paint.setColor(Color.BLACK);
    for (int r = 0; r < matrix.getHeight(); r++)
      for (int c = 0; c < matrix.getWidth(); c++)
        if (matrix.get(c, r))
          canvas.drawRect(
              x + c * cell, y + r * cell, x + (c + 1) * cell, y + (r + 1) * cell, paint);
  }
}
