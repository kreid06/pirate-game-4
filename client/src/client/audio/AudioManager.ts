/**
 * Audio Manager - Game Audio System
 * 
 * Handles all game audio including music, sound effects, and spatial audio.
 * Uses Web Audio API for advanced audio processing.
 */

import { AudioConfig } from '../ClientConfig.js';
import { Vec2 } from '../../common/Vec2.js';

/**
 * Audio source types
 */
export enum AudioSourceType {
  MUSIC = 'music',
  SFX = 'sfx',
  VOICE = 'voice',
  AMBIENT = 'ambient'
}

/**
 * Audio source interface
 */
interface AudioSource {
  id: string;
  type: AudioSourceType;
  buffer: AudioBuffer | null;
  source: AudioBufferSourceNode | null;
  gainNode: GainNode | null;
  position?: Vec2; // For spatial audio
  loop: boolean;
  playing: boolean;
}

/**
 * Sound effect definitions
 */
export const SoundEffects = {
  CANNON_FIRE: 'cannon_fire',
  WATER_SPLASH: 'water_splash',
  WOOD_BREAK: 'wood_break',
  SAIL_FLAP: 'sail_flap',
  ROPE_CREAK: 'rope_creak',
  FOOTSTEPS_WOOD: 'footsteps_wood',
  MODULE_INTERACT: 'module_interact',
} as const;

/**
 * Music tracks
 */
export const MusicTracks = {
  MAIN_THEME: 'main_theme',
  BATTLE_MUSIC: 'battle_music',
  AMBIENT_OCEAN: 'ambient_ocean',
} as const;

/**
 * Main audio manager
 */
export class AudioManager {
  private config: AudioConfig;
  private audioContext: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  
  // Volume control nodes
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private voiceGain: GainNode | null = null;
  
  // Audio sources
  private sources: Map<string, AudioSource> = new Map();
  private loadedBuffers: Map<string, AudioBuffer> = new Map();
  
  // Spatial audio
  private listenerPosition: Vec2 = Vec2.zero();
  
  constructor(config: AudioConfig) {
    this.config = config;
  }
  
  /**
   * Initialize audio system
   */
  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      console.log('🔇 Audio disabled by configuration');
      return;
    }
    
    try {
      // Create audio context
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      
      // Create master gain node
      this.masterGain = this.audioContext.createGain();
      this.masterGain.connect(this.audioContext.destination);
      this.masterGain.gain.value = this.config.masterVolume;
      
      // Create volume control nodes
      this.setupVolumeNodes();
      
      // Load audio assets
      await this.loadAudioAssets();
      
      console.log('🔊 Audio system initialized');
      
    } catch (error) {
      console.error('❌ Failed to initialize audio system:', error);
    }
  }
  
  /**
   * Update audio system
   */
  update(deltaTime: number): void {
    if (!this.audioContext || !this.config.enabled) return;
    
    // Update spatial audio positions
    this.updateSpatialAudio();
    
    // Clean up finished audio sources
    this.cleanupFinishedSources();
  }
  
  /**
   * Play a sound effect
   */
  playSFX(soundId: string, position?: Vec2, volume: number = 1.0): string {
    if (!this.canPlayAudio()) return '';
    
    const buffer = this.loadedBuffers.get(soundId);
    if (!buffer) {
      console.warn(`Sound effect not found: ${soundId}`);
      return '';
    }
    
    const sourceId = `sfx_${soundId}_${Date.now()}_${Math.random()}`;
    
    const source: AudioSource = {
      id: sourceId,
      type: AudioSourceType.SFX,
      buffer,
      source: null,
      gainNode: null,
      position: position?.clone(),
      loop: false,
      playing: false
    };
    
    this.playAudioSource(source, volume);
    this.sources.set(sourceId, source);
    
    return sourceId;
  }
  
  /**
   * Play background music
   */
  playMusic(trackId: string, loop: boolean = true, volume: number = 1.0): string {
    if (!this.canPlayAudio()) return '';
    
    // Stop current music
    this.stopAllMusic();
    
    const buffer = this.loadedBuffers.get(trackId);
    if (!buffer) {
      console.warn(`Music track not found: ${trackId}`);
      return '';
    }
    
    const sourceId = `music_${trackId}`;
    
    const source: AudioSource = {
      id: sourceId,
      type: AudioSourceType.MUSIC,
      buffer,
      source: null,
      gainNode: null,
      loop,
      playing: false
    };
    
    this.playAudioSource(source, volume);
    this.sources.set(sourceId, source);
    
    return sourceId;
  }
  
  /**
   * Stop a specific audio source
   */
  stopAudio(sourceId: string): void {
    const source = this.sources.get(sourceId);
    if (!source || !source.source) return;
    
    source.source.stop();
    source.playing = false;
  }
  
  /**
   * Stop all music
   */
  stopAllMusic(): void {
    for (const [sourceId, source] of this.sources) {
      if (source.type === AudioSourceType.MUSIC && source.playing) {
        this.stopAudio(sourceId);
      }
    }
  }
  
  /**
   * Update listener position for spatial audio
   */
  setListenerPosition(position: Vec2): void {
    this.listenerPosition = position.clone();
  }
  
  /**
   * Update audio configuration
   */
  updateConfig(newConfig: AudioConfig): void {
    this.config = { ...newConfig };
    
    if (!this.canPlayAudio()) return;
    
    // Update volume nodes
    this.masterGain!.gain.value = newConfig.masterVolume;
    this.musicGain!.gain.value = newConfig.musicVolume;
    this.sfxGain!.gain.value = newConfig.sfxVolume;
    this.voiceGain!.gain.value = newConfig.voiceVolume;
    
    console.log('🔊 Audio configuration updated');
  }
  
  /**
   * Shutdown audio system
   */
  shutdown(): void {
    // Stop all audio sources
    for (const [sourceId, source] of this.sources) {
      if (source.playing) {
        this.stopAudio(sourceId);
      }
    }
    
    // Close audio context
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
    }
    
    this.sources.clear();
    this.loadedBuffers.clear();
    
    console.log('🔇 Audio system shutdown');
  }
  
  // Private methods
  
  private canPlayAudio(): boolean {
    return this.config.enabled && this.audioContext !== null && this.masterGain !== null;
  }
  
  private setupVolumeNodes(): void {
    if (!this.audioContext || !this.masterGain) return;
    
    // Create volume nodes for different audio types
    this.musicGain = this.audioContext.createGain();
    this.musicGain.connect(this.masterGain);
    this.musicGain.gain.value = this.config.musicVolume;
    
    this.sfxGain = this.audioContext.createGain();
    this.sfxGain.connect(this.masterGain);
    this.sfxGain.gain.value = this.config.sfxVolume;
    
    this.voiceGain = this.audioContext.createGain();
    this.voiceGain.connect(this.masterGain);
    this.voiceGain.gain.value = this.config.voiceVolume;
  }
  
  private async loadAudioAssets(): Promise<void> {
    // For now, we'll create placeholder audio buffers
    // In a real implementation, these would load from audio files
    
    const sampleBuffers = [
      { id: SoundEffects.CANNON_FIRE, duration: 1.0 },
      { id: SoundEffects.WATER_SPLASH, duration: 0.5 },
      { id: SoundEffects.WOOD_BREAK, duration: 0.3 },
      { id: SoundEffects.SAIL_FLAP, duration: 0.8 },
      { id: SoundEffects.ROPE_CREAK, duration: 1.2 },
      { id: SoundEffects.FOOTSTEPS_WOOD, duration: 0.2 },
      { id: SoundEffects.MODULE_INTERACT, duration: 0.1 },
      { id: MusicTracks.MAIN_THEME, duration: 120.0 },
      { id: MusicTracks.BATTLE_MUSIC, duration: 180.0 },
      { id: MusicTracks.AMBIENT_OCEAN, duration: 300.0 },
    ];
    
    for (const bufferInfo of sampleBuffers) {
      const buffer = await this.createSampleBuffer(bufferInfo.id, bufferInfo.duration);
      if (buffer) {
        this.loadedBuffers.set(bufferInfo.id, buffer);
      }
    }
    
    console.log(`🎵 Loaded ${this.loadedBuffers.size} audio assets`);
  }
  
  private async createSampleBuffer(id: string, duration: number): Promise<AudioBuffer | null> {
    if (!this.audioContext) return null;
    
    const sampleRate = this.audioContext.sampleRate;
    const frameCount = sampleRate * duration;
    const buffer = this.audioContext.createBuffer(2, frameCount, sampleRate);
    
    // Generate sample audio (sine waves for different sounds)
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const channelData = buffer.getChannelData(channel);
      
      for (let i = 0; i < frameCount; i++) {
        // Create different waveforms based on sound type
        let sample = 0;
        
        if (id.includes('cannon') || id.includes('explosion')) {
          // Low frequency rumble with noise
          sample = (Math.random() * 2 - 1) * Math.exp(-i / (frameCount * 0.3)) * 0.5;
        } else if (id.includes('water') || id.includes('splash')) {
          // White noise with high frequency emphasis
          sample = (Math.random() * 2 - 1) * Math.exp(-i / (frameCount * 0.5)) * 0.3;
        } else if (id.includes('music') || id.includes('theme')) {
          // Simple melody (placeholder)
          const freq = 440 * Math.pow(2, Math.sin(i / frameCount * Math.PI * 4) * 0.5);
          sample = Math.sin(2 * Math.PI * freq * i / sampleRate) * 0.1;
        } else {
          // Default sine wave
          sample = Math.sin(2 * Math.PI * 440 * i / sampleRate) * 0.2;
        }
        
        channelData[i] = sample;
      }
    }
    
    return buffer;
  }
  
  private playAudioSource(source: AudioSource, volume: number): void {
    if (!this.audioContext || !source.buffer) return;
    
    // Create audio nodes
    const bufferSource = this.audioContext.createBufferSource();
    const gainNode = this.audioContext.createGain();
    
    bufferSource.buffer = source.buffer;
    bufferSource.loop = source.loop;
    
    // Set volume
    gainNode.gain.value = volume;
    
    // Connect to appropriate volume node
    let outputNode: GainNode;
    switch (source.type) {
      case AudioSourceType.MUSIC:
        outputNode = this.musicGain!;
        break;
      case AudioSourceType.SFX:
        outputNode = this.sfxGain!;
        break;
      case AudioSourceType.VOICE:
        outputNode = this.voiceGain!;
        break;
      default:
        outputNode = this.sfxGain!;
        break;
    }
    
    // Set up audio graph
    bufferSource.connect(gainNode);
    gainNode.connect(outputNode);
    
    // Apply spatial audio if position is specified
    if (source.position && this.config.spatialAudio) {
      this.applySpatialAudio(gainNode, source.position);
    }
    
    // Store references
    source.source = bufferSource;
    source.gainNode = gainNode;
    source.playing = true;
    
    // Handle ended event
    bufferSource.onended = () => {
      source.playing = false;
    };
    
    // Start playback
    bufferSource.start();
  }
  
  private applySpatialAudio(gainNode: GainNode, position: Vec2): void {
    if (!this.audioContext) return;
    
    // Simple distance-based volume attenuation
    const distance = this.listenerPosition.sub(position).length();
    const maxDistance = 500; // Maximum audible distance
    const volume = Math.max(0, 1 - distance / maxDistance);
    
    gainNode.gain.value *= volume;
  }
  
  private updateSpatialAudio(): void {
    if (!this.config.spatialAudio) return;
    
    for (const source of this.sources.values()) {
      if (source.playing && source.position && source.gainNode) {
        this.applySpatialAudio(source.gainNode, source.position);
      }
    }
  }
  
  private cleanupFinishedSources(): void {
    for (const [sourceId, source] of this.sources) {
      if (!source.playing && source.source) {
        // Clean up audio nodes
        source.source.disconnect();
        source.gainNode?.disconnect();
        
        // Remove from sources map
        this.sources.delete(sourceId);
      }
    }
  }
}