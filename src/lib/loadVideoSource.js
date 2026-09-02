let nextSourceId = 1

export function loadVideoSource(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.src = url
    video.onloadedmetadata = () => {
      resolve({ id: nextSourceId++, file, url, name: file.name, duration: video.duration })
    }
  })
}
