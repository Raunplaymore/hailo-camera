const DEFAULTS = {
  inferenceWidth: 640,
  inferenceHeight: 640,
  hefPath: '/usr/share/hailo-models/yolov8s_h8.hef',
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

module.exports = {
  buildGstLaunchArgs,
};
