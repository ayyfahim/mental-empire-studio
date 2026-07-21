import { asBetaOpts, type AutomationStyleConfig, type Project } from './types'

/** Canonical Automation style -> project patch used by preview and final render readers. */
export function automationStyleProjectPatch(style: AutomationStyleConfig, autoBroll: boolean, existingBeta: unknown, seed: number): Partial<Project> {
  const beta = asBetaOpts(existingBeta)
  const edge = style.gradientEdge
  return {
    imageMode: style.imageMode,
    crossfade: style.crossfadeSec,
    motionPreset: style.motionPreset,
    seed,
    captionPreset: style.captionPreset,
    captionFont: style.captionFont,
    captionAnim: style.captionAnimation,
    captionAspect: style.aspectRatio,
    captionLines: style.captionLines,
    captionPosition: style.captionPosition,
    captionOffsetY: style.captionOffsetY,
    captionPace: style.captionPace,
    captionHighlightColor: style.highlightColor,
    captionBoxColor: style.boxColor,
    captionWordsPerPage: style.wordsPerCaption,
    betaOpts: {
      ...beta,
      style: style.videoStyle,
      autoHighlight: style.videoStyle !== 'None',
      overlay: { bottom: edge === 'bottom', top: edge === 'top', left: edge === 'left', right: edge === 'right', intensity: style.gradientIntensity },
      autoZoom: { atStart: style.videoStyle !== 'None', atKeyPhrases: style.videoStyle === 'Intense' },
      broll: {
        ...beta.broll,
        enabled: autoBroll && style.brollMode !== 'off',
        mode: style.brollMode === 'overlay' ? 'overlay' : 'full', density: style.brollDensity, poolSize: style.brollPoolSize,
        poolKey: style.brollPoolKey, fallbackPolicy: style.brollFallbackPolicy, shufflePolicy: style.brollShufflePolicy, seed
      }
    }
  }
}
