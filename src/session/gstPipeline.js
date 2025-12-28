const DEFAULTS = {
  inferenceWidth: 640,
  inferenceHeight: 640,
  hefPath: '/usr/share/hailo-models/yolov8s.hef',
  postProcessLib: 'libyolo_hailortpp_post.so',
  postProcessFunc: 'yolov8s',
};

function resolveModelOptions(model, overrides = {}) {
  const resolvedModel = model || 'yolov8s';
  if (resolvedModel !== 'yolov8s') {
    throw new Error(`Unsupported model: ${resolvedModel}`);
  }
  return { ...DEFAULTS, ...overrides, model: resolvedModel };
}

function buildGstLaunchArgs(options) {
  const { width, height, fps, metaPath } = options;
  const modelOptions = resolveModelOptions(options.model, options.modelOptions);

  return [
    '-e',
    'libcamerasrc',
    '!',
    `video/x-raw,width=${width},height=${height},format=NV12,framerate=${fps}/1`,
    '!',
    'videoscale',
    '!',
    'videoconvert',
    '!',
    `video/x-raw,width=${modelOptions.inferenceWidth},height=${modelOptions.inferenceHeight},format=RGB`,
    '!',
    'hailonet',
    `hef-path=${modelOptions.hefPath}`,
    '!',
    'hailofilter',
    `so-path=${modelOptions.postProcessLib}`,
    `function-name=${modelOptions.postProcessFunc}`,
    '!',
    'hailoexportfile',
    `location=${metaPath}`,
    '!',
    'fakesink',
    'sync=false',
  ];
}

function buildGstShmInferenceArgs(options) {
  const { socketPath, width, height, fps, metaPath } = options;
  const modelOptions = resolveModelOptions(options.model, options.modelOptions);

  return [
    '-e',
    'shmsrc',
    `socket-path=${socketPath}`,
    'is-live=true',
    'do-timestamp=true',
    '!',
    `video/x-raw,width=${width},height=${height},format=NV12,framerate=${fps}/1`,
    '!',
    'videoconvert',
    '!',
    'videoscale',
    '!',
    `video/x-raw,width=${modelOptions.inferenceWidth},height=${modelOptions.inferenceHeight},format=RGB`,
    '!',
    'hailonet',
    `hef-path=${modelOptions.hefPath}`,
    '!',
    'hailofilter',
    `so-path=${modelOptions.postProcessLib}`,
    `function-name=${modelOptions.postProcessFunc}`,
    '!',
    'hailoexportfile',
    `location=${metaPath}`,
    '!',
    'fakesink',
    'sync=false',
  ];
}

function buildGstShmPreviewArgs(options) {
  const { socketPath, srcWidth, srcHeight, srcFps, width, height, fps } = options;
  const outWidth = width || srcWidth;
  const outHeight = height || srcHeight;
  const outFps = fps || srcFps;

  return [
    '-q',
    '-e',
    'shmsrc',
    `socket-path=${socketPath}`,
    'is-live=true',
    'do-timestamp=true',
    '!',
    `video/x-raw,width=${srcWidth},height=${srcHeight},format=NV12,framerate=${srcFps}/1`,
    '!',
    'videoconvert',
    '!',
    'videoscale',
    '!',
    'videorate',
    '!',
    `video/x-raw,width=${outWidth},height=${outHeight},framerate=${outFps}/1`,
    '!',
    'jpegenc',
    '!',
    'multipartmux',
    'boundary=ffmpeg',
    '!',
    'fdsink',
  ];
}

function buildGstShmAiPreviewArgs(options) {
  const { socketPath, srcWidth, srcHeight, srcFps, width, height, fps } = options;
  const modelOptions = resolveModelOptions(options.model, options.modelOptions);
  const outWidth = width || srcWidth;
  const outHeight = height || srcHeight;
  const outFps = fps || srcFps;

  return [
    '-q',
    '-e',
    'shmsrc',
    `socket-path=${socketPath}`,
    'is-live=true',
    'do-timestamp=true',
    '!',
    `video/x-raw,width=${srcWidth},height=${srcHeight},format=NV12,framerate=${srcFps}/1`,
    '!',
    'videoconvert',
    '!',
    'videoscale',
    '!',
    `video/x-raw,width=${modelOptions.inferenceWidth},height=${modelOptions.inferenceHeight},format=RGB`,
    '!',
    'hailonet',
    `hef-path=${modelOptions.hefPath}`,
    '!',
    'hailofilter',
    `so-path=${modelOptions.postProcessLib}`,
    `function-name=${modelOptions.postProcessFunc}`,
    '!',
    'hailooverlay',
    '!',
    'videoconvert',
    '!',
    'videoscale',
    '!',
    'videorate',
    '!',
    `video/x-raw,width=${outWidth},height=${outHeight},framerate=${outFps}/1`,
    '!',
    'jpegenc',
    '!',
    'multipartmux',
    'boundary=ffmpeg',
    '!',
    'fdsink',
  ];
}

function buildGstShmRecordArgs(options) {
  const { socketPath, width, height, fps, outputPath, encoder } = options;
  const selectedEncoder = encoder || 'openh264enc';
  return [
    '-e',
    'shmsrc',
    `socket-path=${socketPath}`,
    'is-live=true',
    'do-timestamp=true',
    '!',
    `video/x-raw,width=${width},height=${height},format=NV12,framerate=${fps}/1`,
    '!',
    'videoconvert',
    '!',
    selectedEncoder,
    '!',
    'h264parse',
    '!',
    'mp4mux',
    'faststart=true',
    '!',
    'filesink',
    `location=${outputPath}`,
  ];
}

function buildGstFileArgs(options) {
  const { inputPath, format, metaPath } = options;
  const modelOptions = resolveModelOptions(options.model, options.modelOptions);
  const sourceArgs = buildFileSourceArgs(format, inputPath);

  return [
    '-e',
    ...sourceArgs,
    '!',
    'videoconvert',
    '!',
    'videoscale',
    '!',
    `video/x-raw,width=${modelOptions.inferenceWidth},height=${modelOptions.inferenceHeight},format=RGB`,
    '!',
    'hailonet',
    `hef-path=${modelOptions.hefPath}`,
    '!',
    'hailofilter',
    `so-path=${modelOptions.postProcessLib}`,
    `function-name=${modelOptions.postProcessFunc}`,
    '!',
    'hailoexportfile',
    `location=${metaPath}`,
    '!',
    'fakesink',
    'sync=false',
  ];
}

function buildFileSourceArgs(format, inputPath) {
  const normalized = (format || '').toLowerCase();
  if (normalized === 'mp4') {
    return [
      'filesrc',
      `location=${inputPath}`,
      '!',
      'qtdemux',
      '!',
      'h264parse',
      '!',
      'avdec_h264',
    ];
  }
  if (normalized === 'h264') {
    return [
      'filesrc',
      `location=${inputPath}`,
      '!',
      'h264parse',
      '!',
      'avdec_h264',
    ];
  }
  if (normalized === 'jpg' || normalized === 'jpeg') {
    return ['filesrc', `location=${inputPath}`, '!', 'jpegdec'];
  }
  throw new Error(`Unsupported format for inference: ${format}`);
}

module.exports = {
  buildGstLaunchArgs,
  buildGstFileArgs,
  buildGstShmInferenceArgs,
  buildGstShmPreviewArgs,
  buildGstShmAiPreviewArgs,
  buildGstShmRecordArgs,
  resolveModelOptions,
};
