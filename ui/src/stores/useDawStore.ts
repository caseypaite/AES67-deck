import { create } from 'zustand';

export interface DawClip {
  id: string;
  trackId: number;
  start: number; // in seconds
  length: number; // in seconds
  color: string;
  name: string;
}

interface DawState {
  clips: Record<string, DawClip>;
  playheadPosition: number; // in seconds
  recordStartTime: number | null; // in seconds
  zoom: number; // pixels per second
  
  // Selection & Clipboard
  selectedClipIds: string[];
  clipboard: DawClip[];
  
  // Track heights (trackId -> height in pixels)
  trackHeights: Record<number, number>;

  // Grid Snapping
  snapToGrid: boolean;
  gridSize: number; // in seconds
  
  setZoom: (zoom: number) => void;
  setPlayheadPosition: (pos: number) => void;
  setRecordStartTime: (time: number | null) => void;
  setSnapToGrid: (snap: boolean) => void;
  setGridSize: (size: number) => void;
  
  // Clip Actions
  addClip: (clip: DawClip) => void;
  updateClip: (id: string, updates: Partial<DawClip>) => void;
  removeClip: (id: string) => void;
  
  // Selection Actions
  setSelectedClips: (ids: string[]) => void;
  toggleClipSelection: (id: string) => void;
  clearSelection: () => void;
  deleteSelected: () => void;
  sliceSelectedAtPlayhead: () => void;
  
  // Copy / Paste
  copySelected: () => void;
  pasteClipboard: () => void;
  
  // Track Actions
  setTrackHeight: (trackId: number, height: number) => void;
}

export const useDawStore = create<DawState>((set, get) => ({
  clips: {
    '1': { id: '1', trackId: 1, start: 2.5, length: 15, color: 'bg-blue-600', name: 'Guitar Take 1' },
    '2': { id: '2', trackId: 1, start: 20, length: 10, color: 'bg-blue-600', name: 'Guitar Take 2' },
    '3': { id: '3', trackId: 2, start: 5, length: 30, color: 'bg-green-600', name: 'Bass DI' },
    '4': { id: '4', trackId: 3, start: 0, length: 45, color: 'bg-red-600', name: 'Drum Overhead' },
    '5': { id: '5', trackId: 4, start: 10, length: 5, color: 'bg-purple-600', name: 'Vocal Scratch' },
  },
  playheadPosition: 0,
  recordStartTime: null,
  zoom: 10, // px per sec
  
  selectedClipIds: [],
  clipboard: [],
  trackHeights: {},

  snapToGrid: true,
  gridSize: 1.0, // 1 second grid by default
  
  setZoom: (zoom) => set({ zoom: Math.max(2, Math.min(100, zoom)) }),
  setPlayheadPosition: (pos) => set({ playheadPosition: Math.max(0, pos) }),
  setRecordStartTime: (time) => set({ recordStartTime: time }),
  setSnapToGrid: (snap) => set({ snapToGrid: snap }),
  setGridSize: (size) => set({ gridSize: size }),
  
  addClip: (clip) => set(state => ({ clips: { ...state.clips, [clip.id]: clip } })),
  updateClip: (id, updates) => set(state => {
    const clip = state.clips[id];
    if (!clip) return state;
    return { clips: { ...state.clips, [id]: { ...clip, ...updates } } };
  }),
  removeClip: (id) => set(state => {
    const nextClips = { ...state.clips };
    delete nextClips[id];
    return { clips: nextClips };
  }),
  
  setSelectedClips: (ids) => set({ selectedClipIds: ids }),
  toggleClipSelection: (id) => set(state => ({
    selectedClipIds: state.selectedClipIds.includes(id) 
      ? state.selectedClipIds.filter(i => i !== id)
      : [...state.selectedClipIds, id]
  })),
  clearSelection: () => set({ selectedClipIds: [] }),
  deleteSelected: () => set(state => {
    const nextClips = { ...state.clips };
    state.selectedClipIds.forEach(id => delete nextClips[id]);
    return { clips: nextClips, selectedClipIds: [] };
  }),
  
  sliceSelectedAtPlayhead: () => set(state => {
    const nextClips = { ...state.clips };
    const newSelection = [...state.selectedClipIds];
    const pos = state.playheadPosition;

    let slicedAny = false;

    state.selectedClipIds.forEach(id => {
      const clip = nextClips[id];
      if (clip && pos > clip.start && pos < (clip.start + clip.length)) {
        slicedAny = true;
        // Clip 1: start -> pos
        const length1 = pos - clip.start;
        // Clip 2: pos -> end
        const length2 = (clip.start + clip.length) - pos;

        // Modify original clip to be Clip 1
        nextClips[id] = { ...clip, length: length1 };

        // Create Clip 2
        const newId = crypto.randomUUID();
        nextClips[newId] = {
          ...clip,
          id: newId,
          start: pos,
          length: length2,
        };
        newSelection.push(newId);
      }
    });

    if (slicedAny) {
      return { clips: nextClips, selectedClipIds: newSelection };
    }
    return state;
  }),
  
  copySelected: () => set(state => {
    const toCopy = state.selectedClipIds.map(id => state.clips[id]).filter(Boolean);
    return { clipboard: toCopy };
  }),
  pasteClipboard: () => set(state => {
    if (state.clipboard.length === 0) return state;
    
    // Find earliest start time in clipboard to calculate offset
    const earliestStart = Math.min(...state.clipboard.map(c => c.start));
    const offset = state.playheadPosition - earliestStart;
    
    const nextClips = { ...state.clips };
    const newSelection: string[] = [];
    
    state.clipboard.forEach(clip => {
      const newId = crypto.randomUUID();
      nextClips[newId] = {
        ...clip,
        id: newId,
        start: Math.max(0, clip.start + offset),
      };
      newSelection.push(newId);
    });
    
    return { clips: nextClips, selectedClipIds: newSelection };
  }),
  
  setTrackHeight: (trackId, height) => set(state => ({
    trackHeights: { ...state.trackHeights, [trackId]: Math.max(48, height) }
  })),
}));
