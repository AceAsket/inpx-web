use std::fs::File;
use std::io::{self, BufReader, BufWriter, Write};
use std::path::Path;

use inpx_catalog::Result;
use inpx_catalog::legacy_library_files::NATIVE_JXL_LIMIT;
use jxl::api::{
    AlphaMode, Endianness, Event, ExtraChannel, JxlBitDepth, JxlColorType, JxlDataFormat,
    JxlDecoder, JxlDecoderOptions, JxlOutputBuffer, JxlPixelFormat,
};

const MAX_PIXELS: usize = 32 * 1024 * 1024;

// The parent enforces the deadline and keeps native and fallback work in the same image slot.
pub(crate) fn worker(input: &Path, output: &Path, limit: usize) -> Result<()> {
    let result = decode(File::open(input)?, output, limit);
    if let Err(error) = &result
        && (error
            .downcast_ref::<io::Error>()
            .is_some_and(|e| e.kind() == io::ErrorKind::FileTooLarge)
            || matches!(
                error.downcast_ref::<jxl::error::Error>(),
                Some(
                    jxl::error::Error::ImageSizeTooLarge(..)
                        | jxl::error::Error::PaletteTooLarge(..)
                )
            ))
    {
        std::process::exit(NATIVE_JXL_LIMIT);
    }
    result
}

fn decode(input: File, output: &Path, limit: usize) -> Result<()> {
    if input.metadata()?.len() > 64 * 1024 * 1024 {
        return Err(io::Error::from(io::ErrorKind::FileTooLarge).into());
    }
    let mut source = BufReader::new(input);
    let mut options = JxlDecoderOptions::default();
    options.alpha_mode = AlphaMode::Unpremultiplied;
    options.sample_limit = Some(4 * MAX_PIXELS + 1);
    let mut decoder = JxlDecoder::new(options);
    if decoder.process(&mut source, None, None)? != Event::BasicInfo {
        return Err("Incomplete JPEG XL header".into());
    }
    let info = decoder.basic_info().ok_or("Missing JPEG XL header")?;
    let (width, height) = info.size;
    if width > 16384 || height > 16384 || width * height > MAX_PIXELS {
        return Err(io::Error::from(io::ErrorKind::FileTooLarge).into());
    }
    if info
        .extra_channels
        .iter()
        .any(|ch| ch.ec_type == ExtraChannel::Black)
    {
        return Err("CMYK JPEG XL requires djxl".into());
    }
    let alpha = info
        .extra_channels
        .iter()
        .any(|ch| ch.ec_type == ExtraChannel::Alpha);
    let gray = decoder
        .current_pixel_format()
        .ok_or("Missing JPEG XL pixel format")?
        .color_type
        .is_grayscale();
    let (color, png_color) = match (gray, alpha) {
        (true, false) => (JxlColorType::Grayscale, png::ColorType::Grayscale),
        (true, true) => (JxlColorType::GrayscaleAlpha, png::ColorType::GrayscaleAlpha),
        (false, false) => (JxlColorType::Rgb, png::ColorType::Rgb),
        (false, true) => (JxlColorType::Rgba, png::ColorType::Rgba),
    };
    let (format, depth) = match info.bit_depth {
        JxlBitDepth::Int {
            bits_per_sample: 1..=8,
        } => (JxlDataFormat::U8 { bit_depth: 8 }, png::BitDepth::Eight),
        _ => (
            JxlDataFormat::U16 {
                bit_depth: 16,
                endianness: Endianness::BigEndian,
            },
            png::BitDepth::Sixteen,
        ),
    };
    decoder.set_pixel_format(JxlPixelFormat {
        color_type: color,
        color_data_format: Some(format),
        extra_channel_format: vec![None; info.extra_channels.len()],
    })?;
    let mut png_info = png::Info::with_size(width as u32, height as u32);
    png_info.color_type = png_color;
    png_info.bit_depth = depth;
    png_info.icc_profile = Some(
        decoder
            .output_color_profile()
            .and_then(|p| p.try_as_icc())
            .ok_or("JPEG XL color profile cannot be represented in PNG")?
            .into_owned()
            .into(),
    );

    let stride = width * color.samples_per_pixel() * format.bytes_per_sample();
    let len = stride * height;
    // jxl requires each 16-bit scanline to be aligned, including for big-endian PNG samples.
    let mut aligned = vec![0u16; len.div_ceil(2)];
    let pixels = &mut bytemuck::cast_slice_mut(&mut aligned)[..len];
    let mut buffer = [JxlOutputBuffer::new(pixels, height, stride)];
    loop {
        match decoder.process(&mut source, Some(&mut buffer), None)? {
            Event::FrameHeader => continue,
            Event::FrameComplete { .. } => break,
            _ => return Err("Incomplete JPEG XL frame".into()),
        }
    }
    drop(decoder);
    let file = CappedOutput {
        file: BufWriter::new(File::create_new(output)?),
        remaining: limit,
    };
    let mut encoder = png::Encoder::with_info(file, png_info)?;
    encoder.set_compression(png::Compression::Fast);
    let mut writer = encoder.write_header()?;
    let mut stream = writer.stream_writer()?;
    stream.write_all(pixels)?;
    stream.finish()?;
    writer.finish()?;
    Ok(())
}

struct CappedOutput {
    file: BufWriter<File>,
    remaining: usize,
}

impl Write for CappedOutput {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.len() > self.remaining {
            // A different PNG encoder can fit the same pixels within the response limit.
            return Err(io::ErrorKind::QuotaExceeded.into());
        }
        let written = self.file.write(buf)?;
        self.remaining -= written;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}
