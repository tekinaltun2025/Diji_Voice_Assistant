#!/usr/bin/env python3
"""
Drifting TTS kopru sunucusu (Node <-> Python).

Neden bu dosya var:
  `Vyvo/drifting-tts-tr` (Drifting TTS, tek adimli Turkce TTS) PyTorch
  agirliklariyla calisir ve yalnizca Python'dadir. Node tarafindaki TTS
  motoru (agent/src/tts.ts) ham PCM uretmesi gerektiginden, kalici bir alt
  surec olarak calisan bu kopru kullanilir. Model yuklemesi ~60-70 saniye
  surdugu icin her sentezde yeni surec baslatmak kabul edilemez; surec omru
  boyunca ayakta kalir ve istekleri sirayla isler.

Protokol (stdin/stdout, binary-guvenli):
  Node -> Python (satir basina bir JSON, UTF-8):
      {"id": 1, "text": "Merhaba dunya.", "speed": 1.0, "sampleRate": 48000}
      {"id": 2, "op": "shutdown"}

  Python -> Node (stdout):
      4 bayt  : buyuk-endian uint32 -> ornekleme frekansi (Hz)
      4 bayt  : buyuk-endian uint32 -> yuk uzunlugu (bayt)
      N bayt  : yuk

      Basarida yuk = S16_LE mono PCM.
      Hatada  ornekleme frekansi = 0, yuk = UTF-8 hata metni.

  Loglar stderr'e yazilir; boylece stdout ikili veri icin temiz kalir.

Ortam degiskenleri:
  DIJI_TTS_DEVICE        auto|cuda|cpu   (varsayilan: auto)
  DIJI_TTS_VOICE         studio|male|female|<konusmaci-id>  (varsayilan: studio)
  DIJI_TTS_RELEASE       v3.2|v3.1       (varsayilan: v3.2)
  DIJI_TTS_CFG           CFG olcegi       (varsayilan: 2.0)
  DIJI_TTS_TEMPERATURE   gurultu sicakligi (varsayilan: 0.3)
  DIJI_TTS_SEED          tohum            (varsayilan: 0)
  DRIFTING_TTS_HUB_DIR   yerel agirlik dizini (paket destekli, opsiyonel)
  HF_HOME / HF_HUB_OFFLINE  huggingface_hub tarafindan okunur
"""

from __future__ import annotations

import json
import os
import struct
import sys
import traceback
from math import gcd

# Drifting TTS'in native cikis frekansi (drifting_tts.audio.SAMPLE_RATE).
NATIVE_SAMPLE_RATE = 24000

# Istekte bulunulabilecek hedef frekanslar. Listedeki degerler icin scipy
# ile polyphase yeniden ornekleme yapilir; liste disindaki degerler icin en
# yakin desteklenen frekansa dusulur ve bu stderr'e loglanir.
SUPPORTED_SAMPLE_RATES = (16000, 22050, 24000, 44100, 48000)

# Metin parcalama: tek istekte asiri uzun metin GPU belleğini sisirmesin.
MAX_CHARS_PER_CHUNK = 400


def log(message: str) -> None:
    """stderr'e log yaz (stdout ikili protokol icin ayrilmis)."""
    sys.stderr.write(f"[drifting-bridge] {message}\n")
    sys.stderr.flush()


def write_frame(sample_rate: int, payload: bytes) -> None:
    """stdout'a tek bir cerceve yaz ve hemen bosalt."""
    header = struct.pack(">II", sample_rate, len(payload))
    sys.stdout.buffer.write(header)
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def write_error(message: str) -> None:
    """sampleRate=0 + UTF-8 hata metni."""
    write_frame(0, message.encode("utf-8", errors="replace"))


def float_to_pcm16(samples) -> bytes:
    """float32 (-1..1) ornekleri S16_LE baytina cevir."""
    import numpy as np  # type: ignore

    arr = np.asarray(samples, dtype=np.float32).reshape(-1)
    np.clip(arr, -1.0, 1.0, out=arr)
    return (arr * 32767.0).astype("<i2").tobytes()


def resolve_device() -> str:
    """DIJI_TTS_DEVICE cozumle: auto -> cuda varsa cuda, yoksa cpu."""
    requested = os.environ.get("DIJI_TTS_DEVICE", "auto").strip().lower()
    if requested not in ("auto", "cuda", "cpu"):
        log(f"gecersiz DIJI_TTS_DEVICE={requested!r}, 'auto' kullaniliyor")
        requested = "auto"

    if requested != "auto":
        return requested

    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            try:
                name = torch.cuda.get_device_name(0)
            except Exception:  # noqa: BLE001 - isim alinamazsa sorun degil
                name = "?"
            log(f"CUDA/ROCm cihazi bulundu: {name}")
            return "cuda"
    except Exception as exc:  # noqa: BLE001 - torch yoksa CPU'ya dus
        log(f"torch incelenemedi, CPU kullanilacak: {exc}")

    return "cpu"


def split_into_chunks(text: str) -> list[str]:
    """Uzun metni cumle sinirlarinda parcala; tek parca yeterliyse aynen doner."""
    if len(text) <= MAX_CHARS_PER_CHUNK:
        return [text]

    # Basit ama etkili bolme: noktalama sonrasi bosluklardan bol.
    separators = ".!?…;:\n"
    chunks: list[str] = []
    current = ""

    for char in text:
        current += char
        if char in separators and len(current) >= MAX_CHARS_PER_CHUNK:
            chunks.append(current.strip())
            current = ""

    if current.strip():
        # Kalan parca hâlâ cok uzunsa sert bol.
        rest = current.strip()
        while len(rest) > MAX_CHARS_PER_CHUNK:
            chunks.append(rest[:MAX_CHARS_PER_CHUNK])
            rest = rest[MAX_CHARS_PER_CHUNK:]
        if rest:
            chunks.append(rest)

    return [c for c in chunks if c]


def nearest_supported(sample_rate: int) -> int:
    """Liste disindaki frekansi en yakin desteklenen degere yuvarla."""
    return min(SUPPORTED_SAMPLE_RATES, key=lambda rate: abs(rate - sample_rate))


def resample(audio, source_rate: int, target_rate: int):
    """float32 diziyi source_rate -> target_rate'e yeniden ornekle."""
    import numpy as np  # type: ignore

    if source_rate == target_rate:
        return audio

    # scipy varsa polyphase (yuksek kalite, hizli) kullan.
    try:
        from scipy.signal import resample_poly  # type: ignore

        divisor = gcd(int(source_rate), int(target_rate))
        up = int(target_rate) // divisor
        down = int(source_rate) // divisor
        return resample_poly(np.asarray(audio, dtype=np.float32), up, down).astype(
            np.float32
        )
    except Exception as exc:  # noqa: BLE001 - scipy yoksa torchaudio'ya dus
        log(f"scipy resample kullanilamadi ({exc}); torchaudio deneniyor")

    try:
        import torch  # type: ignore
        import torchaudio  # type: ignore

        tensor = torch.from_numpy(np.asarray(audio, dtype=np.float32)).unsqueeze(0)
        out = torchaudio.functional.resample(tensor, int(source_rate), int(target_rate))
        return out.squeeze(0).numpy().astype(np.float32)
    except Exception as exc:  # noqa: BLE001 - son care: dogrusal interpolasyon
        log(f"torchaudio resample kullanilamadi ({exc}); dogrusal interpolasyon")

    source = np.asarray(audio, dtype=np.float32)
    count = int(round(len(source) * target_rate / source_rate))
    if count <= 0:
        return np.zeros(0, dtype=np.float32)
    source_positions = np.arange(len(source), dtype=np.float64)
    target_positions = np.linspace(0, len(source) - 1, count, dtype=np.float64)
    return np.interp(target_positions, source_positions, source).astype(np.float32)


def load_engine():
    """Drifting TTS Synthesizer'ini yukle. Hata durumunda mesaji yukari firlat."""
    from drifting_tts.synthesize import Synthesizer  # type: ignore

    release = os.environ.get("DIJI_TTS_RELEASE", "v3.2").strip() or "v3.2"
    device = resolve_device()

    log(f"Drifting TTS yukleniyor (release={release}, device={device})")
    engine = Synthesizer.from_pretrained(release, device)
    log("Drifting TTS hazir")
    return engine, device, release


def synthesize_text(engine, text: str, speed: float) -> tuple[object, int]:
    """Metni sentezle; (float32 numpy dizisi, native ornekleme hizi) dondur."""
    import numpy as np  # type: ignore

    speaker = os.environ.get("DIJI_TTS_VOICE", "studio").strip() or "studio"
    cfg_scale = float(os.environ.get("DIJI_TTS_CFG", "2.0"))
    temperature = float(os.environ.get("DIJI_TTS_TEMPERATURE", "0.3"))
    seed = int(os.environ.get("DIJI_TTS_SEED", "0"))

    # `length_scale` > 1 -> daha yavas. Hiz carpani tersine cevrilir.
    length_scale = 1.0 / max(0.25, min(4.0, float(speed or 1.0)))

    pieces = []
    for chunk in split_into_chunks(text):
        wav, info = engine(
            chunk,
            speaker=speaker,
            cfg_scale=cfg_scale,
            temperature=temperature,
            length_scale=length_scale,
            seed=seed,
        )
        log(f"parca={len(chunk)} krkt sure={info.get('seconds', '?')}s")
        tensor = wav.detach().cpu() if hasattr(wav, "detach") else wav
        pieces.append(np.asarray(tensor, dtype=np.float32).reshape(-1))

    if not pieces:
        return np.zeros(0, dtype=np.float32), NATIVE_SAMPLE_RATE

    # Parcalar arasina kisa bir sessizlik koy (cumleler birbirine yapismasin).
    gap = np.zeros(int(NATIVE_SAMPLE_RATE * 0.12), dtype=np.float32)
    merged = []
    for index, piece in enumerate(pieces):
        if index > 0:
            merged.append(gap)
        merged.append(piece)

    return np.concatenate(merged), NATIVE_SAMPLE_RATE


def main() -> int:
    # stdout'u tamponsuz ikili yazima hazirla.
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001 - eski Python'larda yoksay
        pass

    try:
        engine, device, release = load_engine()
    except Exception as exc:  # noqa: BLE001 - tum yukleme hatalari Node'a iletilir
        log(f"Drifting TTS yuklenemedi: {exc}")
        log(traceback.format_exc())
        # Node tarafi ilk istegi gonderip hata cercevesi alacak.
        engine = None
        device = "?"
        release = "?"
        load_error = str(exc)
    else:
        load_error = ""

    stdin = sys.stdin.buffer
    while True:
        raw_line = stdin.readline()
        if not raw_line:
            log("stdin kapandi, cikiliyor")
            return 0

        line = raw_line.decode("utf-8", errors="replace").strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            write_error(f"Gecersiz JSON: {exc}")
            continue

        if request.get("op") == "shutdown":
            log("kapatma istegi alindi")
            return 0

        request_id = request.get("id")
        text = (request.get("text") or "").strip()
        if not text:
            write_error("Bos metin")
            continue

        if engine is None:
            write_error(f"Drifting TTS yuklenemedi: {load_error}")
            continue

        speed = float(request.get("speed") or 1.0)
        requested_rate = int(request.get("sampleRate") or NATIVE_SAMPLE_RATE)

        if requested_rate <= 0:
            requested_rate = NATIVE_SAMPLE_RATE

        if requested_rate not in SUPPORTED_SAMPLE_RATES:
            target_rate = nearest_supported(requested_rate)
            log(
                f"desteklenmeyen ornekleme hizi {requested_rate} Hz; "
                f"en yakin desteklenen {target_rate} Hz kullaniliyor"
            )
        else:
            target_rate = requested_rate

        try:
            audio, native_rate = synthesize_text(engine, text, speed)
            if audio.size == 0:
                write_error("Sentez bos ses uretti")
                continue

            if target_rate != native_rate:
                audio = resample(audio, native_rate, target_rate)

            payload = float_to_pcm16(audio)
            log(
                f"id={request_id} krkt={len(text)} cihaz={device} "
                f"sure={len(payload) / 2 / target_rate:.2f}s sr={target_rate}"
            )
            write_frame(target_rate, payload)
        except Exception as exc:  # noqa: BLE001 - tum hatalar Node'a iletilir
            log(f"id={request_id} sentez hatasi: {exc}")
            log(traceback.format_exc())
            write_error(f"Sentez hatasi: {exc}")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
