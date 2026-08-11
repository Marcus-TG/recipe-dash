import { useEffect } from 'react'

/**
 * Keep the screen on while cooking.
 *
 * The official Wake Lock API only exists on HTTPS pages, and Larder runs on
 * plain HTTP by choice — so we try it first and fall back to the old trick of
 * playing a silent 2x2 video, which keeps most phones awake without any
 * secure-context requirement.
 */
export function useKeepAwake(active: boolean) {
  useEffect(() => {
    if (!active) return
    let released = false
    let sentinel: any = null
    let video: HTMLVideoElement | null = null
    let painter: number | null = null

    const acquire = async () => {
      const wakeLock = (navigator as any).wakeLock
      if (wakeLock?.request) {
        try {
          sentinel = await wakeLock.request('screen')
          if (released) sentinel.release?.()
          return
        } catch {
          /* fall through to the video trick */
        }
      }
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 2
      const ctx = canvas.getContext('2d')
      painter = window.setInterval(() => {
        if (!ctx) return
        ctx.fillStyle = ctx.fillStyle === '#000000' ? '#010101' : '#000000'
        ctx.fillRect(0, 0, 2, 2)
      }, 1000)
      const stream = (canvas as any).captureStream?.(1)
      if (!stream) return
      video = document.createElement('video')
      video.srcObject = stream
      video.muted = true
      video.loop = true
      video.setAttribute('playsinline', '')
      video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none'
      document.body.appendChild(video)
      try {
        await video.play()
      } catch {
        /* autoplay refused — the screen may sleep; nothing else we can do */
      }
    }

    // Re-acquire when returning to the tab: both mechanisms drop on hide.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !sentinel) void acquire()
    }
    document.addEventListener('visibilitychange', onVisible)
    void acquire()

    return () => {
      released = true
      document.removeEventListener('visibilitychange', onVisible)
      sentinel?.release?.()
      if (painter) clearInterval(painter)
      if (video) {
        video.pause()
        video.remove()
      }
    }
  }, [active])
}
