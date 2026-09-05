<script setup lang="ts">
/**
 * `docs/plans/P6.md` W14: a real `menu`/`menuitem` (§6.6/W20 — not a native context menu, and not
 * a div soup with click handlers only a mouse can reach). Opens at a point (`x`/`y`) — the click
 * coordinates for a right-click, or a row's own bounding rect for `Shift+F10`/the Menu key — and
 * renders whatever `rowMenuModel.ts`'s pure `buildRowMenu`/`buildRefMenu` produced; this file adds
 * nothing to "what is in the menu", only how it opens, moves focus and closes.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { MenuSection } from "./rowMenuModel.ts";

const props = defineProps<{
  sections: readonly MenuSection[];
  x: number;
  y: number;
  label: string;
}>();

const emit = defineEmits<{
  (e: "select", id: string): void;
  (e: "close"): void;
}>();

const rootEl = ref<HTMLDivElement | null>(null);
const menuEl = ref<HTMLDivElement | null>(null);

const flatItems = computed(() => props.sections.flatMap((section) => section.items));

function itemId(id: string): string {
  return `kv-row-menu-item-${id}`;
}

const focusedId = ref<string | undefined>(flatItems.value.find((item) => !item.disabled)?.id);

function focusItem(id: string | undefined): void {
  if (id === undefined) return;
  focusedId.value = id;
  menuEl.value?.querySelector<HTMLElement>(`#${itemId(id)}`)?.focus();
}

function enabledNeighbour(fromId: string | undefined, direction: 1 | -1): string | undefined {
  const items = flatItems.value;
  if (items.length === 0) return undefined;
  const startIndex = fromId === undefined ? -1 : items.findIndex((item) => item.id === fromId);
  for (let step = 1; step <= items.length; step++) {
    const index = (((startIndex + direction * step) % items.length) + items.length) % items.length;
    const candidate = items[index];
    if (candidate && !candidate.disabled) return candidate.id;
  }
  return undefined;
}

function onKeydown(event: KeyboardEvent): void {
  switch (event.key) {
    case "Escape":
      event.preventDefault();
      emit("close");
      break;
    case "ArrowDown":
      event.preventDefault();
      focusItem(enabledNeighbour(focusedId.value, 1));
      break;
    case "ArrowUp":
      event.preventDefault();
      focusItem(enabledNeighbour(focusedId.value, -1));
      break;
    case "Home":
      event.preventDefault();
      focusItem(enabledNeighbour(undefined, 1));
      break;
    case "End":
      event.preventDefault();
      focusItem(enabledNeighbour(undefined, -1));
      break;
    case "Enter":
    case " ":
      event.preventDefault();
      activate(focusedId.value);
      break;
    case "Tab":
      // A menu does not participate in normal tab order (§6.6/W20) — closing it here rather than
      // letting focus leave to whatever the page's own next tab stop happens to be.
      event.preventDefault();
      emit("close");
      break;
    default:
      break;
  }
}

function activate(id: string | undefined): void {
  if (id === undefined) return;
  const item = flatItems.value.find((entry) => entry.id === id);
  if (!item || item.disabled) return;
  emit("select", id);
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (rootEl.value && event.target instanceof Node && rootEl.value.contains(event.target)) return;
  emit("close");
}

/** Clamps the panel back on-screen — a right-click near the panel's own right/bottom edge must
 *  not render a menu whose own items are partly off the viewport. */
const style = ref({ left: `${props.x}px`, top: `${props.y}px` });

onMounted(() => {
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  focusItem(focusedId.value);
  requestAnimationFrame(() => {
    const el = menuEl.value;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - rect.width - 4);
    const maxTop = Math.max(0, window.innerHeight - rect.height - 4);
    style.value = {
      left: `${Math.min(props.x, maxLeft)}px`,
      top: `${Math.min(props.y, maxTop)}px`,
    };
  });
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocumentPointerDown, true);
});
</script>

<template>
  <div ref="rootEl" class="kv-row-menu-root">
    <div
      ref="menuEl"
      class="kv-row-menu"
      role="menu"
      :aria-label="label"
      :style="style"
      @keydown="onKeydown"
    >
      <template v-for="(section, sectionIndex) in sections" :key="sectionIndex">
        <div v-if="sectionIndex > 0" class="kv-row-menu-separator" role="separator"></div>
        <div
          v-for="item in section.items"
          :id="itemId(item.id)"
          :key="item.id"
          class="kv-row-menu-item"
          :class="{ 'kv-row-menu-item--disabled': item.disabled }"
          role="menuitem"
          :aria-disabled="item.disabled"
          :aria-describedby="item.disabled && item.disabledReason ? `${itemId(item.id)}-reason` : undefined"
          :tabindex="focusedId === item.id ? 0 : -1"
          @click="activate(item.id)"
          @mouseenter="focusedId = item.id"
        >
          <span>{{ item.label }}</span>
          <span
            v-if="item.disabled && item.disabledReason"
            :id="`${itemId(item.id)}-reason`"
            class="kv-visually-hidden"
          >
            {{ item.disabledReason }}
          </span>
        </div>
      </template>
    </div>
  </div>
</template>

<style>
.kv-row-menu {
  position: fixed;
  z-index: 30;
  min-width: 220px;
  max-width: 320px;
  padding: var(--kv-space-1) 0;
  background-color: var(--kv-panel-bg);
  border: 1px solid var(--kv-panel-border);
  border-radius: var(--kv-radius);
  box-shadow: 0 2px 8px var(--kv-widget-shadow);
}

.kv-row-menu-item {
  display: flex;
  align-items: center;
  padding: var(--kv-space-1) var(--kv-space-3);
  cursor: pointer;
  color: var(--kv-app-fg);
  white-space: nowrap;
}

.kv-row-menu-item:hover:not(.kv-row-menu-item--disabled),
.kv-row-menu-item:focus-visible:not(.kv-row-menu-item--disabled) {
  background-color: var(--kv-row-hover-bg);
  outline: none;
}

.kv-row-menu-item--disabled {
  color: var(--kv-description-fg);
  cursor: default;
}

.kv-row-menu-separator {
  height: 1px;
  margin: var(--kv-space-1) 0;
  background-color: var(--kv-panel-border);
}

.kv-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
