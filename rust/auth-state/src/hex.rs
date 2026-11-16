pub(crate) fn hex32(bytes: &[u8; 32]) -> [u8; 64] {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = [0; 64];
    for (hex, &byte) in out.as_chunks_mut::<2>().0.iter_mut().zip(bytes) {
        hex[0] = HEX[usize::from(byte >> 4)];
        hex[1] = HEX[usize::from(byte & 15)];
    }
    out
}
