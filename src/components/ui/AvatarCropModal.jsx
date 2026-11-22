import { useCallback, useEffect, useRef, useState } from "react";
import Cropper from "react-easy-crop";
import Modal from "../modals/Modal.jsx";

/**
 * AvatarCropModal — pan + zoom cropper for avatar uploads.
 *
 * Caller gives us a File (whatever the user picked). We show a square
 * 1:1 cropper with drag-to-pan + wheel/pinch-to-zoom. On Save we hand
 * back a cropped JPEG Blob the caller can upload (via uploadFile, etc).
 *
 * Why not read the File ourselves and upload here too? Each call site
 * owns its own upload flow (different folders, different post-upload
 * state updates, different error toasts). Keeping this component
 * concerned only with the crop output keeps it reusable.
 *
 * Props:
 *   open           boolean
 *   file           File | null — the user-picked source image
 *   onClose        () => void
 *   onCropped      (blob: Blob) => void | Promise<void>
 *                    Fires with the cropped JPEG Blob on Save. Caller is
 *                    responsible for uploading + updating state. We stay
 *                    open with a spinner while the handler's Promise is
 *                    in flight so Save can't be double-clicked.
 *   outputSize     number — final square size in px. Default 512, which
 *                    is plenty for a 48–96px avatar on retina screens.
 */
export default function AvatarCropModal({
  open,
  file,
  onClose,
  onCropped,
  outputSize = 512,
}) {
  // Convert incoming File → object URL so react-easy-crop can render it.
  // Revoked on unmount / new file to avoid leaking blobs.
  const [imageUrl, setImageUrl] = useState(null);
  useEffect(() => {
    if (!file) { setImageUrl(null); return; }
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Reset crop state whenever a new file lands — otherwise the next
  // upload would open at the previous photo's zoom/offset.
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedPixels, setCroppedPixels] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setCroppedPixels(null);
  }, [file]);

  const onCropComplete = useCallback((_, areaPixels) => {
    setCroppedPixels(areaPixels);
  }, []);

  // Keyboard a11y: Esc to close, Enter to save. Modal.jsx handles Esc on
  // backdrop click but not on keypress when focus is inside the cropper.
  const saveRef = useRef(null);

  async function handleSave() {
    if (!croppedPixels || !imageUrl || saving) return;
    setSaving(true);
    try {
      const blob = await getCroppedBlob(imageUrl, croppedPixels, outputSize);
      // Wrap in a File so FormData.append gives it a proper filename +
      // mime type — the backend upload handler reads these for the
      // Cloudinary resource_type / public_id. A raw Blob would arrive
      // as `blob` with octet-stream content-type, which some middlewares
      // reject as non-image.
      const baseName = (file?.name || 'avatar').replace(/\.[^.]+$/, '');
      const cropped = new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' });
      await onCropped(cropped);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={saving ? () => {} : onClose} maxWidth="max-w-md" label="Adjust avatar">
      <div className="p-5 space-y-4">
        <div>
          <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <i className="fas fa-crop-simple text-sky-600" aria-hidden="true"></i>
            Adjust your photo
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Drag to reposition. Scroll or pinch to zoom.
          </p>
        </div>

        {/* Cropper surface — square aspect, circular preview overlay so
            the user sees exactly what the avatar will look like displayed. */}
        <div className="relative w-full aspect-square bg-slate-900 rounded-xl overflow-hidden">
          {imageUrl && (
            <Cropper
              image={imageUrl}
              crop={crop}
              zoom={zoom}
              aspect={1}
              cropShape="round"
              showGrid={false}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={onCropComplete}
              minZoom={1}
              maxZoom={4}
              zoomSpeed={0.3}
            />
          )}
        </div>

        {/* Zoom slider — fallback for desktop users without a scroll
            wheel + explicit control for anyone who finds pinch awkward. */}
        <div className="flex items-center gap-3">
          <i className="fas fa-magnifying-glass-minus text-slate-400 text-sm" aria-hidden="true"></i>
          <input
            type="range"
            min={1}
            max={4}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            disabled={saving}
            aria-label="Zoom"
            className="flex-1 accent-sky-600"
          />
          <i className="fas fa-magnifying-glass-plus text-slate-400 text-sm" aria-hidden="true"></i>
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="inline-flex items-center justify-center min-h-11 px-4 py-2 border border-slate-300 rounded-lg text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2"
          >
            Cancel
          </button>
          <button
            ref={saveRef}
            type="button"
            onClick={handleSave}
            disabled={!croppedPixels || saving}
            className="inline-flex items-center justify-center min-h-11 px-4 py-2 bg-sky-600 text-white rounded-lg text-sm font-medium hover:bg-sky-700 disabled:opacity-50 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2"
          >
            {saving ? (
              <><i className="fas fa-spinner fa-spin mr-2" aria-hidden="true"></i>Uploading…</>
            ) : (
              <><i className="fas fa-check mr-2" aria-hidden="true"></i>Save</>
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// Render the cropped region of the source image onto a square canvas of
// outputSize × outputSize, then export as a JPEG Blob (smaller than PNG
// for photo content, matches what Cloudinary serves anyway). JPEG quality
// of 0.9 is the sweet spot — visually indistinguishable from source,
// ~40% smaller files.
async function getCroppedBlob(imageSrc, pixelCrop, outputSize) {
  const image = await loadImage(imageSrc);
  const canvas = document.createElement("canvas");
  canvas.width = outputSize;
  canvas.height = outputSize;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(
    image,
    pixelCrop.x, pixelCrop.y, pixelCrop.width, pixelCrop.height,
    0, 0, outputSize, outputSize
  );
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("Canvas blob failed")),
      "image/jpeg",
      0.9
    );
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.crossOrigin = "anonymous";  // required for canvas.toBlob on CORS images, harmless locally
    img.src = src;
  });
}
