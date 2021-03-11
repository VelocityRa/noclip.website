import * as Viewer from '../viewer';
import * as UI from '../ui';
import { FakeTextureHolder } from '../TextureHolder';
import { GfxDevice, GfxRenderPass, GfxBindingLayoutDescriptor, GfxMegaStateDescriptor, GfxCullMode, GfxFrontFaceMode, GfxBlendMode, GfxBlendFactor, GfxSampler, GfxTexture, GfxWrapMode, GfxTexFilterMode, GfxMipFilterMode, GfxProgramDescriptorSimple, makeTextureDescriptor2D, GfxColor } from "../gfx/platform/GfxPlatform";
import { preprocessProgramObj_GLSL, DefineMap } from "../gfx/shaderc/GfxShaderCompiler";
import { pushAntialiasingPostProcessPass, opaqueBlackFullClearRenderPassDescriptor } from "../gfx/helpers/RenderGraphHelpers";
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper';
import { GfxRenderInstManager, GfxRendererLayer, makeSortKey, makeSortKeyOpaque } from "../gfx/render/GfxRenderInstManager";
import { fillVec2v, fillMatrix4x4, fillMatrix4x3, fillVec4, fillVec4v, fillColor } from "../gfx/helpers/UniformBufferHelpers";
import { mat4, vec3, vec2, vec4 } from "gl-matrix";
import { computeViewMatrix, CameraController, computeViewMatrixSkybox } from "../Camera";
import { nArray, assertExists, hexzero0x, hexzero, binzero, binzero0b } from "../util";
import { TextureMapping } from "../TextureHolder";
import { MathConstants, scaleMatrix } from "../MathHelpers";
import { AABB } from "../Geometry";
import { setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers";
import { drawWorldSpaceAABB, getDebugOverlayCanvas2D, drawWorldSpacePoint } from "../DebugJunk";
import { Color, Magenta, colorToCSS, Red, Green, Blue, Cyan } from "../Color";
import { GfxBuffer, GfxInputLayout, GfxInputState, GfxBufferUsage, GfxVertexAttributeDescriptor, GfxFormat, GfxInputLayoutBufferDescriptor, GfxVertexBufferFrequency } from "../gfx/platform/GfxPlatform";
import { makeStaticDataBuffer } from "../gfx/helpers/BufferHelpers";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import { GfxrAttachmentSlot, makeBackbufferDescSimple } from '../gfx/render/GfxRenderGraph';

export class Sly2Renderer implements Viewer.SceneGfx {
    constructor(device: GfxDevice) {
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput) {
    }

    public destroy(device: GfxDevice): void {
    }
}
