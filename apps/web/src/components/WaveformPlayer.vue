<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import WaveSurfer from "wavesurfer.js";
import { clampAnnotationRange } from "@practice/contracts";
import { annotationLabels, formatTimeMs } from "../utils/format.js";

export interface WaveAnnotation {
  id: string;
  type: "RHYTHM" | "FINGERING" | "EMOTION";
  title: string;
  severity: number;
  startMs: number;
  endMs: number;
}

const props = defineProps<{
  url: string | null;
  peaks?: number[] | null;
  annotations?: WaveAnnotation[];
  selectedId?: string | null;
  readonly?: boolean;
}>();

const emit = defineEmits<{
  select: [id: string];
  time: [timeMs: number];
  ready: [durationMs: number];
  position: [timeMs: number];
  rangeChange: [payload: { id: string; startMs: number; endMs: number }];
}>();

const container = ref<HTMLDivElement | null>(null);
const markerTrack = ref<HTMLDivElement | null>(null);
const currentMs = ref(0);
const durationMs = ref(0);
const playing = ref(false);
const rate = ref("1");
const zoom = ref(1);
const loopStart = ref<number | null>(null);
const loopEnd = ref<number | null>(null);
let wave: WaveSurfer | null = null;

// 拖动过程中本地预览的区间（毫秒），拖动结束后才持久化。
const dragPreview = ref<{ id: string; startMs: number; endMs: number } | null>(null);
let dragState:
  | { id: string; mode: "move" | "start" | "end"; startMs: number; endMs: number; originMs: number; moved: boolean }
  | null = null;

const markerStyles = computed(() => {
  const total = durationMs.value || 1;
  return (props.annotations ?? []).map((annotation) => {
    const preview = dragPreview.value?.id === annotation.id ? dragPreview.value : annotation;
    return {
      ...annotation,
      startMs: preview.startMs,
      endMs: preview.endMs,
      left: `${Math.max(0, (preview.startMs / total) * 100)}%`,
      width: `${Math.max(0.15, ((preview.endMs - preview.startMs) / total) * 100)}%`,
    };
  });
});

const ruler = computed(() => {
  const total = durationMs.value;
  return [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({ ratio, label: formatTimeMs(total * ratio) }));
});

function msFromClientX(clientX: number): number {
  const rect = markerTrack.value?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || durationMs.value <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  return ratio * durationMs.value;
}

function startDrag(event: PointerEvent, marker: WaveAnnotation, mode: "move" | "start" | "end"): void {
  if (props.readonly) return;
  event.preventDefault();
  event.stopPropagation();
  dragState = {
    id: marker.id,
    mode,
    startMs: marker.startMs,
    endMs: marker.endMs,
    originMs: msFromClientX(event.clientX),
    moved: false,
  };
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragEnd, { once: true });
  window.addEventListener("pointercancel", onDragEnd, { once: true });
}

function onDragMove(event: PointerEvent): void {
  if (!dragState) return;
  const pointerMs = msFromClientX(event.clientX);
  if (!dragState.moved && Math.abs(pointerMs - dragState.originMs) < 15) return;
  dragState.moved = true;
  const delta = pointerMs - dragState.originMs;
  const raw =
    dragState.mode === "move"
      ? { startMs: dragState.startMs + delta, endMs: dragState.endMs + delta }
      : dragState.mode === "start"
        ? { startMs: pointerMs, endMs: dragState.endMs }
        : { startMs: dragState.startMs, endMs: pointerMs };
  dragPreview.value = {
    id: dragState.id,
    ...clampAnnotationRange(raw.startMs, raw.endMs, durationMs.value || null, dragState.mode),
  };
}

function onDragEnd(): void {
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", onDragEnd);
  window.removeEventListener("pointercancel", onDragEnd);
  const state = dragState;
  const preview = dragPreview.value;
  dragState = null;
  dragPreview.value = null;
  if (state && state.moved && preview) {
    emit("rangeChange", { id: state.id, startMs: preview.startMs, endMs: preview.endMs });
  }
}

async function createWave(): Promise<void> {
  await nextTick();
  if (!container.value || !props.url) return;
  wave?.destroy();
  wave = WaveSurfer.create({
    container: container.value,
    height: 154,
    waveColor: "#80a29b",
    progressColor: "#145c55",
    cursorColor: "#193f3a",
    cursorWidth: 2,
    barWidth: 2,
    barGap: 1,
    barRadius: 2,
    normalize: true,
    interact: !props.readonly,
    url: props.url,
    peaks: props.peaks?.length ? [props.peaks] : undefined,
    duration: durationMs.value ? durationMs.value / 1000 : undefined,
  });
  wave.setPlaybackRate(Number(rate.value));
  wave.on("ready", (duration) => {
    durationMs.value = Math.round(duration * 1000);
    emit("ready", durationMs.value);
  });
  wave.on("play", () => { playing.value = true; });
  wave.on("pause", () => { playing.value = false; });
  wave.on("finish", () => { playing.value = false; });
  wave.on("timeupdate", (time) => {
    currentMs.value = Math.round(time * 1000);
    emit("position", currentMs.value);
    if (loopStart.value != null && loopEnd.value != null && currentMs.value >= loopEnd.value) {
      wave?.setTime(loopStart.value / 1000);
    }
  });
  wave.on("interaction", (time) => {
    currentMs.value = Math.round(time * 1000);
    emit("time", currentMs.value);
  });
}

function playPause(): void {
  void wave?.playPause();
}
function getCurrentTime(): number { return currentMs.value; }
function getDuration(): number { return durationMs.value; }
function seek(ms: number): void { wave?.setTime(Math.max(0, Math.min(ms, durationMs.value)) / 1000); }
function setLoop(start: number | null, end: number | null): void {
  loopStart.value = start;
  loopEnd.value = end;
}
function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
  if (event.code === "Space") { event.preventDefault(); playPause(); }
  if (event.code === "ArrowLeft") { event.preventDefault(); seek(currentMs.value - 5000); }
  if (event.code === "ArrowRight") { event.preventDefault(); seek(currentMs.value + 5000); }
}
watch(() => [props.url, props.peaks], () => void createWave());
watch(rate, (value) => wave?.setPlaybackRate(Number(value)));
watch(zoom, (value) => wave?.zoom(value));
onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  void createWave();
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("pointerup", onDragEnd);
  window.removeEventListener("pointercancel", onDragEnd);
  wave?.destroy();
});
defineExpose({ playPause, seek, getCurrentTime, getDuration, setLoop });
</script>

<template>
  <section class="wave-panel">
    <div class="wave-toolbar">
      <button class="button small" type="button" :disabled="!url" @click="playPause">{{ playing ? "暂停" : "播放" }}</button>
      <span class="time-display">{{ formatTimeMs(currentMs) }} / {{ formatTimeMs(durationMs) }}</span>
      <label class="speed-control">速度
        <select v-model="rate">
          <option>0.5</option><option>0.75</option><option>1</option><option>1.25</option><option>1.5</option>
        </select>
      </label>
      <label class="zoom-control">缩放 {{ zoom.toFixed(1) }}x
        <input v-model.number="zoom" type="range" min="1" max="50" step="0.5" />
      </label>
    </div>
    <div class="ruler" aria-hidden="true">
      <span v-for="tick in ruler" :key="tick.ratio" :style="{ left: `${tick.ratio * 100}%` }">{{ tick.label }}</span>
    </div>
    <div v-if="!url" class="empty waveform-empty">选择一段已就绪音频后显示真实波形</div>
    <div v-show="url" ref="container" class="waveform"></div>
    <div v-if="url" ref="markerTrack" class="marker-track" aria-label="问题标记轨">
      <div
        v-for="marker in markerStyles"
        :key="marker.id"
        class="wave-marker"
        :class="[marker.type, { selected: marker.id === selectedId, dragging: dragPreview?.id === marker.id }]"
        :style="{ left: marker.left, width: marker.width }"
        :title="`${annotationLabels[marker.type]}：${marker.title}，严重度 ${marker.severity}`"
        role="button"
        tabindex="0"
        @click="emit('select', marker.id)"
        @pointerdown="startDrag($event, marker, 'move')"
      >
        <span v-if="!readonly" class="handle handle-start" aria-hidden="true" @pointerdown.stop="startDrag($event, marker, 'start')" />
        <span class="marker-label">{{ annotationLabels[marker.type] }} · {{ marker.severity }}</span>
        <span v-if="!readonly" class="handle handle-end" aria-hidden="true" @pointerdown.stop="startDrag($event, marker, 'end')" />
      </div>
      <div v-if="currentMs" class="playhead" :style="{ left: `${durationMs ? (currentMs / durationMs) * 100 : 0}%` }" />
    </div>
  </section>
</template>

<style scoped>
.wave-panel { border: 1px solid var(--line); border-radius: var(--radius); background: #fbfcfb; overflow: hidden; }
.wave-toolbar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 12px 14px; border-bottom: 1px solid var(--line); background: #fff; }
.time-display { font-variant-numeric: tabular-nums; font-weight: 750; min-width: 135px; }
.speed-control, .zoom-control { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: .86rem; }
.speed-control select { width: 78px; padding: 5px 7px; }
.zoom-control { margin-left: auto; }
.zoom-control input { width: 150px; padding: 0; }
.ruler { position: relative; height: 24px; margin: 8px 16px 0; border-bottom: 1px solid var(--line); }
.ruler span { position: absolute; bottom: 4px; transform: translateX(-50%); font-size: .68rem; color: var(--muted); white-space: nowrap; }
.waveform { min-height: 170px; padding: 0 16px 6px; }
.waveform-empty { margin: 16px; }
.marker-track { position: relative; height: 38px; margin: 0 16px 12px; border: 1px solid var(--line); border-radius: 8px; background: #eef2f0; overflow: hidden; }
.wave-marker { position: absolute; top: 6px; height: 24px; min-width: 3px; padding: 0 4px; border: 1px solid rgb(0 0 0 / 12%); border-radius: 5px; overflow: hidden; color: #fff; font-size: .67rem; text-align: left; cursor: pointer; display: flex; align-items: center; box-sizing: border-box; touch-action: none; user-select: none; }
.wave-marker.dragging { cursor: grabbing; opacity: .92; }
.wave-marker .marker-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; pointer-events: none; }
.wave-marker .handle { display: none; width: 6px; align-self: stretch; flex: 0 0 6px; background: rgb(255 255 255 / 70%); cursor: ew-resize; }
.wave-marker .handle-start { border-radius: 4px 0 0 4px; margin-right: 3px; }
.wave-marker .handle-end { border-radius: 0 4px 4px 0; margin-left: 3px; }
.wave-marker.selected .handle, .wave-marker:hover .handle { display: block; }
.wave-marker.RHYTHM { background: var(--rhythm); }
.wave-marker.FINGERING { background: var(--fingering); }
.wave-marker.EMOTION { background: var(--emotion); }
.wave-marker.selected { outline: 3px solid #14201e; outline-offset: 1px; z-index: 2; }
.playhead { position: absolute; top: 0; bottom: 0; width: 2px; background: #132823; pointer-events: none; }
@media (max-width: 700px) {
  .zoom-control { width: 100%; margin-left: 0; }
  .zoom-control input { flex: 1; }
  .wave-toolbar { gap: 9px; }
}
</style>
