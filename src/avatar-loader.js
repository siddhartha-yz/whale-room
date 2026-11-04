export const LOCAL_AVATAR_URL = '/assets/deepseek-chibi.vrm';
export const PUBLIC_AVATAR_URL = '/assets/avatar.vrm';

/** Load the optional local model first, then the redistributed pixiv sample. */
export async function loadAvatarModel(loader) {
  const errors = [];
  for (const modelSource of [LOCAL_AVATAR_URL, PUBLIC_AVATAR_URL]) {
    try {
      const gltf = await loader.loadAsync(modelSource);
      const vrm = gltf?.userData?.vrm;
      if (!vrm?.humanoid || !vrm.expressionManager) throw new Error('角色文件没有可用的人形骨骼或表情绑定。');
      return { vrm, modelSource, usingFallback: modelSource === PUBLIC_AVATAR_URL };
    } catch (error) { errors.push(error); }
  }
  throw new AggregateError(errors, '本地角色和公开示例都无法加载，请检查 public/assets/avatar.vrm。');
}
