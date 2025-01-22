import {GfxCompareMode, GfxFrontFaceMode} from '../gfx/platform/GfxPlatform';
import { mat4, vec3, vec4 } from 'gl-matrix';

import { DeviceProgram } from '../Program';
import * as Viewer from '../viewer';
import * as UI from '../ui';

import { GfxDevice, GfxBufferUsage, GfxBuffer, GfxFormat, GfxInputLayout, GfxProgram, GfxBindingLayoutDescriptor, GfxRenderPass, GfxBindings, GfxVertexBufferFrequency, GfxVertexAttributeDescriptor, GfxInputLayoutBufferDescriptor, GfxCullMode, GfxBlendFactor, GfxBlendMode, GfxTexture, makeTextureDescriptor2D, GfxMipFilterMode, GfxTexFilterMode, GfxWrapMode, GfxVertexBufferDescriptor, GfxIndexBufferDescriptor } from '../gfx/platform/GfxPlatform';
import { fillColor, fillFloat, fillMatrix4x3, fillMatrix4x4, fillVec4, fillVec4v } from '../gfx/helpers/UniformBufferHelpers';
import { makeBackbufferDescSimple, standardFullClearRenderPassDescriptor } from '../gfx/helpers/RenderGraphHelpers';
import { makeStaticDataBuffer } from '../gfx/helpers/BufferHelpers';
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper';
import { GfxRendererLayer, GfxRenderInstList, GfxRenderInstManager, makeSortKey, setSortKeyLayer } from '../gfx/render/GfxRenderInstManager';
import { CameraController } from '../Camera';
import { GfxrAttachmentSlot } from '../gfx/render/GfxRenderGraph';
import { Red } from '../Color';
import { DumpChunk } from './bin';
import { setAttachmentStateSimple } from '../gfx/helpers/GfxMegaStateDescriptorHelpers';
import { interactiveVizSliderSelect } from '../DebugJunk';
import { TextureMapping } from '../TextureHolder';
import { DataFetcher } from '../DataFetcher';
import { reverseDepthForCompareMode } from '../gfx/helpers/ReversedDepthHelpers';
import { sceneGroup } from './scenes';
import { assert } from '../util';
import { IS_DEVELOPMENT } from '../BuildVersion';


class SlyDumpProgram extends DeviceProgram {
    public static a_Position = 0;
    public static a_Normal = 1;
    public static a_Texcoord = 2;
    public static a_Diff = 3;
    public static a_Spec = 4;

    public static ub_SceneParams = 0;
    public static ub_ObjectParams = 1;

    public override both = `
precision mediump float;

layout(std140, row_major) uniform ub_SceneParams {
    mat4 u_Projection;
    mat4x3 u_ModelView;
};

layout(std140, row_major) uniform ub_ObjectParams {
    vec4 vc17;
    vec4 u_TexcoordOffset; // vc18
    vec4 u_AmbientColor; // vc19
    vec4 u_gVecFogParams; // vc29
    mat4x4 u_GameProjectionMat;
    float u_DrawType; // TODO: specify at compile time
    float u_TransformBranchBits;
    vec4 u_fc80;
    vec4 u_fc160;
};

layout(binding = 0) uniform sampler2D u_Texture;

varying vec3 v_Normal;
varying vec2 v_Texcoord;
varying vec4 v_Diff;
varying vec4 v_Spec;
varying vec3 v_AmbientColor;
varying float v_Depth;

#define M_Normal 0.0
#define M_Skydome 1.0
#define M_Nospec 2.0
#define M_Water 3.0
#define M_Skeletal 4.0
#define M_Normal2 5.0

#ifdef VERT
layout(location = ${SlyDumpProgram.a_Position}) attribute vec3 a_Position;
layout(location = ${SlyDumpProgram.a_Normal}) attribute vec3 a_Normal;
layout(location = ${SlyDumpProgram.a_Texcoord}) attribute vec2 a_Texcoord;
layout(location = ${SlyDumpProgram.a_Diff}) attribute vec4 a_Diff;
layout(location = ${SlyDumpProgram.a_Spec}) attribute vec4 a_Spec;

float saturate(float x) {
    return clamp(x, 0.0, 1.0);
}

void mainVS() {
    vec4 diffSpecMultiplier = vc17;

    v_Normal = a_Normal;
    v_Diff = a_Diff * diffSpecMultiplier;
    v_Spec = a_Spec * diffSpecMultiplier;
    if (u_DrawType == M_Normal2) {
        v_AmbientColor = u_fc160.rgb;
    } else {
        v_AmbientColor = u_AmbientColor.rgb;
    }
    v_Texcoord = u_TexcoordOffset.xy + a_Texcoord;

    vec3 pos = a_Position.xzy * vec3(1.0, 1.0, -1.0);

    vec3 modelViewPos;
    if (u_DrawType == M_Skydome) {
        mat4x3 modelView = u_ModelView;
        // modelView.mx.w = 0.0;
        // modelView.my.w = -5000.0;
        // modelView.mz.w = 0.0;
        modelViewPos = modelView * vec4(pos, 1.0);
    } else {
        modelViewPos = u_ModelView * vec4(pos, 1.0);
    }

    gl_Position = u_Projection * vec4(modelViewPos, 1.0);

    // HACK
    v_Depth = 1.0 - saturate(pow(gl_Position.z / 900.0, 2.0));
    // v_Depth = (1.0 - saturate((gl_Position.z - 450.0) * u_gVecFogParams.y * 100.0)) * u_gVecFogParams.w * 2.0;

    // v_Depth = saturate((gl_Position.z - u_gVecFogParams.x) * u_gVecFogParams.y) * u_gVecFogParams.w;
    // v_Depth = saturate(((1.0 - gl_Position.z) - 5500.0) * 0.00002) * 0.4;
    // v_Depth = saturate(1.0 - v_Depth) * 0.4;

    // v_Depth = saturate(((1.0 - gl_Position.z) - u_gVecFogParams.x) * u_gVecFogParams.y) * u_gVecFogParams.w;
    // v_Depth = saturate(((1.0 - gl_Position.z) - 5500.0) * 0.00002) * 0.4;
}
#endif

// TODO
#define IS_TRANSPARENT true

#ifdef FRAG
float saturate(float x) {
    return clamp(x, 0.0, 1.0);
}
vec4 saturate(vec4 x) {
    return clamp(x, 0.0, 1.0);
}
vec4 fma4(vec4 a, vec4 b, vec4 c) {
    return a * b + c;
}

void mainPS() {
    // gl_FragColor = vec4(c, c, c, 1.0); return;
    // gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); return;
    // gl_FragColor = vec4(vec3(pow(v_Depth, 1.0)), 1.0); return;

    vec4 diff_color = v_Diff; // rgb is vertex color (have to do *2). a is transparency for something
    vec4 spec_color = v_Spec; // rgb is lighting related. a is lighting related

    vec4 h0 = vec4(0.);
    vec4 h1 = vec4(0.);
	vec4 h2 = vec4(0.);
	vec4 h3 = vec4(0.);

	vec4 tex = texture(SAMPLER_2D(u_Texture), v_Texcoord);
    // gl_FragColor = vec4(tex.rgb, 1.0); return;

    // gl_FragColor = tex; gl_FragColor.a = 1.0; return;
    // gl_FragColor = spec_color; gl_FragColor.a = 1.0; return;
    // gl_FragColor = spec_color.aaaa; gl_FragColor.a = 1.0; return;
    // gl_FragColor = spec_color.rrrr; gl_FragColor.a = 1.0; return;
    // gl_FragColor = spec_color.gggg; gl_FragColor.a = 1.0; return;
    // gl_FragColor = spec_color.bbbb; gl_FragColor.a = 1.0; return;
    // gl_FragColor = spec_color.aaaa; gl_FragColor.a = 1.0; return;
    // gl_FragColor = diff_color*vec4(2.); gl_FragColor.a = 1.0; return;
    // gl_FragColor = diff_color.aaaa; gl_FragColor.a = 1.0; return;
    // gl_FragColor.rgb = v_AmbientColor; gl_FragColor.a = 1.0; return;
    // gl_FragColor = u_fc80; gl_FragColor.a = 1.0; return;
    // gl_FragColor = u_fc160; gl_FragColor.a = 1.0; return;
    // gl_FragColor.rgb = v_Normal; gl_FragColor.a = 1.0; return;

    // if (u_DrawType == M_Normal2) {
    //     gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); return;
    // } else {
    //     gl_FragColor = vec4(0.0, 1.0, 0.0, 1.0); return;
    // }

    // if (u_DrawType == M_Water) {
    //     gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
    //     return;
    // }
    // if (u_DrawType == M_Skeletal) {
    //     gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
    //     return;
    // }

    // if (u_DrawType == M_Skeletal || u_DrawType == M_Water) {
    //     bool is_skinned = ((int(u_TransformBranchBits) & 0x110) != 0);
    //     bool is_lighting = ((int(u_TransformBranchBits) & 0x10) != 0);
    //     gl_FragColor = vec4(is_skinned ? 1.0 : 0.0, is_lighting ? 1.0 : 0.0, 0.0, 1.0);
    //     return;
    // } else if (u_DrawType == M_Skydome) {
    //     gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    // } else {
    //     gl_FragColor = vec4(0.0, 0.0, 1.0, 1.0);
    //     return;
    // }

    // if (u_DrawType == M_Skeletal || u_DrawType == M_Water) {
    //     bool is_lighting = ((int(u_TransformBranchBits) & 0x10) != 0);
    //     if (is_lighting) {
    //         // gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); return;
    //         spec_color = vec4(0.26, 0.26, 0.26, 0.5);
    //         diff_color = vec4(0.26, 0.26, 0.26, 0.5);
    //     }
    // }

    if (    u_DrawType == M_Normal  ||
            u_DrawType == M_Normal2 ||
            u_DrawType == M_Skeletal||
            u_DrawType == M_Water) {
        h1 = tex;
        h2 = spec_color;
        h2.rgb = ((h1 * h2) * 2.).rgb;
        h0 = saturate(diff_color);
        h0.a = h0.a * h1.a * 2.0;  // actual shader does * 4 but we * 2 at dump time
        h1.x = vec4(dot(h1.rgb, u_fc80.rgb)).x;
        h3.rgb = h0.rgb * h1.xxx * 2.;
        h1.rgb = h2.rgb - vec3(v_Depth) * h2.rgb;
        h0.rgb = v_AmbientColor - h3.rgb;
        h0.rgb = (v_Depth * h0.rgb + h3.rgb) / 2.;
        h0.rgb = (h1.rgb * h2.aaa + h0.rgb) * 2.;
    } else if (u_DrawType == M_Nospec ||
               u_DrawType == M_Skydome) {
        h1 = tex;
        h0 = saturate(diff_color);
        h0 = h0 * h1 * 2.; // actual shader does * 4 to alpha but we * 2 at dump time
        h1.xyz = v_AmbientColor - h0.rgb;
        h2.w = v_Depth;
        h0.xyz = h2.www * h1.rgb + h0.rgb;
    // } else if (u_DrawType == M_Water) {
    //     h0 = tex;
    //     h1 = saturate(diff_color);
    //     h0 = h1 * h0 * 2.; // actual shader does * 4 to alpha but we * 2 at dump time
    } else {
        h0 = vec4(1.0, 0.0, 0.0, 1.0);
    }

#ifdef IS_TRANSPARENT
    if (h0.a < 1.0 - 0.98824)
        discard;
#endif

    gl_FragColor = h0;
}
#endif
`;
}


export class SlyDumpRenderer {
    public visible: boolean = true;
    public name: string;

    public numVertices: number;
    public posBuffer: GfxBuffer;
    public nrmBuffer: GfxBuffer;
    public texcoordsBuffer: GfxBuffer;
    public diffBuffer: GfxBuffer;
    public specBuffer: GfxBuffer;

    public numIndices: number;
    public indexBuffer: GfxBuffer;

    public vertexBufferDescriptors: GfxVertexBufferDescriptor[];
    public indexBufferDescriptor: GfxIndexBufferDescriptor;

    // debug
    public sortKey: number;
    public isAllDiffAlphaOpaque = true;

    constructor(device: GfxDevice, public dumpChunk: DumpChunk, private inputLayout: GfxInputLayout, private textureMapping: TextureMapping | null) {
        this.name = dumpChunk.name;

        const vertexData = dumpChunk.vertexData;
        const indexData = dumpChunk.indexData;

        this.posBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Vertex, vertexData.positions.buffer);
        this.nrmBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Vertex, vertexData.normals.buffer);
        this.texcoordsBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Vertex, vertexData.texcoords.buffer);
        this.diffBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Vertex, vertexData.diff.buffer);
        this.specBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Vertex, vertexData.spec.buffer);

        this.indexBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Index, indexData.buffer);
        this.numIndices = indexData.length;

        this.vertexBufferDescriptors = [
            { buffer: this.posBuffer, byteOffset: 0, },
            { buffer: this.nrmBuffer, byteOffset: 0, },
            { buffer: this.texcoordsBuffer, byteOffset: 0, },
            { buffer: this.diffBuffer, byteOffset: 0, },
            { buffer: this.specBuffer, byteOffset: 0, },
        ];
        this.indexBufferDescriptor = { buffer: this.indexBuffer, byteOffset: 0 };

        this.numVertices = vertexData.positions.length;

        for (let i = 0; i < vertexData.diff.length; i += 4) {
            if (vertexData.diff[i + 3] < 0.5) {
                this.isAllDiffAlphaOpaque = false;
                break;
            }
        }
    }

    public setVisible(v: boolean) {
        this.visible = v;
    }

    public prepareToRender(renderInstManager: GfxRenderInstManager): void {
        if (!this.visible)
            return;

        const isOpaque = (this.dumpChunk.textureIsOpaque && this.isAllDiffAlphaOpaque);

        const isSkydome = (this.dumpChunk.drawType == 1);
        // if (isSkydome) // TODO: debug
            // return;
        let rendererLayer: GfxRendererLayer;
        if (isSkydome)
            rendererLayer = GfxRendererLayer.BACKGROUND;
        else if (isOpaque)
            rendererLayer = GfxRendererLayer.OPAQUE;
        else
            rendererLayer = GfxRendererLayer.TRANSLUCENT;

        const template = renderInstManager.pushTemplate();
        // template.sortKey = this.dumpChunk.index;
        template.sortKey = ((rendererLayer << 23) >>> 0) | (this.dumpChunk.index >>> 0);
        this.sortKey = template.sortKey;

        template.getMegaStateFlags().cullMode = isOpaque ? GfxCullMode.Back : GfxCullMode.None;
        template.getMegaStateFlags().depthWrite = !isSkydome;
        template.getMegaStateFlags().depthCompare = reverseDepthForCompareMode((isSkydome) ? GfxCompareMode.Always : GfxCompareMode.Less);
        // template.getMegaStateFlags().frontFace = isSkydome ? GfxFrontFaceMode.CW : GfxFrontFaceMode.CCW;
        template.getMegaStateFlags().frontFace = GfxFrontFaceMode.CCW;

        let offs = template.allocateUniformBuffer(SlyDumpProgram.ub_ObjectParams, 4*4 + 4*4 + 4 + 1 + 1 + 4 + 4);
        const d = template.mapUniformBufferF32(SlyDumpProgram.ub_ObjectParams);
        offs += fillVec4v(d, offs, this.dumpChunk.vc17);

        // TODO: is this right? doesn't make sense, normal 2 is used for waves
        if (this.dumpChunk.drawType == 5.0) { // Normal2
            offs += fillVec4v(d, offs, vec4.create());
        } else {
            offs += fillVec4v(d, offs, this.dumpChunk.vc18);
        }

        if (this.dumpChunk.drawType == 5.0) { // Normal2
            // const fc160 = this.dumpChunk.fc.get(160)!;
            // offs += fillVec4v(d, offs, fc160);
            offs += fillVec4(d, offs, 1.0, 0.0, 0.0, 1.0); // dummy
        } else
            offs += fillVec4v(d, offs, this.dumpChunk.vc19_ambientColor);
        offs += fillVec4v(d, offs, this.dumpChunk.vc29);
        offs += fillMatrix4x4(d, offs, this.dumpChunk.projMatrix);
        offs += fillFloat(d, offs, this.dumpChunk.drawType);
        offs += fillFloat(d, offs, this.dumpChunk.transformBranchBits);
        offs += 2; // align
        if (this.dumpChunk.fc.get(80) !== undefined)
            offs += fillVec4v(d, offs, this.dumpChunk.fc.get(80)!);
        else
            offs += fillVec4(d, offs, 1.0, 0.0, 0.0, 1.0); // dummy
        if (this.dumpChunk.fc.get(160) !== undefined)
            offs += fillVec4v(d, offs, this.dumpChunk.fc.get(160)!);
        else
            offs += fillVec4(d, offs, 0.0, 0.0, 1.0, 1.0); // dummy

        if (this.textureMapping) {
            template.setSamplerBindingsFromTextureMappings([this.textureMapping]);
        }

        template.setVertexInput(this.inputLayout, this.vertexBufferDescriptors, this.indexBufferDescriptor);

        const renderInst = renderInstManager.newRenderInst();
        renderInst.setDrawCount(this.numIndices);
        renderInstManager.submitRenderInst(renderInst);

        renderInstManager.popTemplate();
    }

    public destroy(device: GfxDevice): void {
        device.destroyBuffer(this.posBuffer);
        device.destroyBuffer(this.nrmBuffer);
        device.destroyBuffer(this.indexBuffer);
        device.destroyBuffer(this.texcoordsBuffer);
    }
}

const bindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 2, numSamplers: 1 }, // ub_SceneParams
];


function makeTextureFromImageData(device: GfxDevice, imageData: ImageData): GfxTexture {
    const texture = device.createTexture(makeTextureDescriptor2D(GfxFormat.U8_RGBA_NORM, imageData.width, imageData.height, 1));
    device.uploadTextureData(texture, 0, [new Uint8Array(imageData.data.buffer)]);
    return texture;
}

export class Scene implements Viewer.SceneGfx {
    private inputLayout: GfxInputLayout;
    private program: GfxProgram;
    private slyDumpRenderers: SlyDumpRenderer[] = [];
    // private textureMappings: Map<string, TextureMapping> = new Map();
    private renderHelper: GfxRenderHelper;
    private renderInstListMain = new GfxRenderInstList();

    constructor(device: GfxDevice, dumpChunks: DumpChunk[], textures: Map<string, ImageData>) {
        this.renderHelper = new GfxRenderHelper(device);

        const cache = this.renderHelper.renderCache;
        this.program = cache.createProgram(new SlyDumpProgram());


        const vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [
            { location: SlyDumpProgram.a_Position,   bufferIndex: 0, bufferByteOffset: 0, format: GfxFormat.F32_RGB, },
            { location: SlyDumpProgram.a_Normal,     bufferIndex: 1, bufferByteOffset: 0, format: GfxFormat.F32_RGB, },
            { location: SlyDumpProgram.a_Texcoord,   bufferIndex: 2, bufferByteOffset: 0, format: GfxFormat.F32_RG, },
            { location: SlyDumpProgram.a_Diff,     bufferIndex: 3, bufferByteOffset: 0, format: GfxFormat.F32_RGBA, },
            { location: SlyDumpProgram.a_Spec,     bufferIndex: 4, bufferByteOffset: 0, format: GfxFormat.F32_RGBA, },
        ];
        const vertexBufferDescriptors: GfxInputLayoutBufferDescriptor[] = [
            { byteStride: 3*0x04, frequency: GfxVertexBufferFrequency.PerVertex, },
            { byteStride: 3*0x04, frequency: GfxVertexBufferFrequency.PerVertex, },
            { byteStride: 2*0x04, frequency: GfxVertexBufferFrequency.PerVertex, },
            { byteStride: 4*0x04, frequency: GfxVertexBufferFrequency.PerVertex, },
            { byteStride: 4*0x04, frequency: GfxVertexBufferFrequency.PerVertex, },
        ];
        const indexBufferFormat = GfxFormat.U16_R;
        this.inputLayout = cache.createInputLayout({ vertexAttributeDescriptors, vertexBufferDescriptors, indexBufferFormat });

        const samplerBilinear = device.createSampler({
            wrapS: GfxWrapMode.Repeat,
            wrapT: GfxWrapMode.Repeat,
            minFilter: GfxTexFilterMode.Bilinear,
            magFilter: GfxTexFilterMode.Bilinear,
            mipFilter: GfxMipFilterMode.Nearest,
            minLOD: 0, maxLOD: 0,
        });

        let textureMappings: Map<string, TextureMapping> = new Map()
        for (let [name, imageData] of textures) {
            let textureMapping = new TextureMapping();
            textureMapping.gfxTexture = makeTextureFromImageData(device, imageData);
            textureMapping.gfxSampler = samplerBilinear;
            textureMapping.width = imageData.width;
            textureMapping.height = imageData.height;
            textureMappings.set(name, textureMapping);
        }

        this.slyDumpRenderers = dumpChunks.map((dumpChunk) => {
            let tex: TextureMapping | null = null;
            if (dumpChunk.textureName) {
                let texTemp = textureMappings.get(dumpChunk.textureName!);
                if (texTemp)
                    tex = texTemp!;
            }
            // debugger;
            return new SlyDumpRenderer(device, dumpChunk, this.inputLayout, tex);
        });
    }

    // For debugging
    public objectSelect(): void {
        interactiveVizSliderSelect(this.slyDumpRenderers, 'visible', (instance) => {
            console.log(instance);
        });
    }

    public adjustCameraController(c: CameraController) {
        c.setSceneMoveSpeedMult(0.6);
    }

    private prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
        const template = this.renderHelper.pushTemplateRenderInst();
        template.setBindingLayouts(bindingLayouts);
        template.setGfxProgram(this.program);
        template.setMegaStateFlags(setAttachmentStateSimple({
            cullMode: GfxCullMode.Back,
        }, {
            blendMode: GfxBlendMode.Add,
            blendSrcFactor: GfxBlendFactor.SrcAlpha,
            blendDstFactor: GfxBlendFactor.OneMinusSrcAlpha,
        }));

        viewerInput.camera.setClipPlanes(800, 140000);

        let offs = template.allocateUniformBuffer(SlyDumpProgram.ub_SceneParams, 32);
        const mapped = template.mapUniformBufferF32(SlyDumpProgram.ub_SceneParams);
        offs += fillMatrix4x4(mapped, offs, viewerInput.camera.projectionMatrix);
        offs += fillMatrix4x3(mapped, offs, viewerInput.camera.viewMatrix);

        this.renderHelper.renderInstManager.setCurrentList(this.renderInstListMain);

        for (let i = 0; i < this.slyDumpRenderers.length; i++)
            this.slyDumpRenderers[i].prepareToRender(this.renderHelper.renderInstManager);

        this.renderHelper.renderInstManager.popTemplate();
        this.renderHelper.prepareToRender();
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput) {
        const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, standardFullClearRenderPassDescriptor);
        const mainDepthDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, viewerInput, standardFullClearRenderPassDescriptor);

        const builder = this.renderHelper.renderGraph.newGraphBuilder();

        const mainColorTargetID = builder.createRenderTargetID(mainColorDesc, 'Main Color');
        const mainDepthTargetID = builder.createRenderTargetID(mainDepthDesc, 'Main Depth');
        builder.pushPass((pass) => {
            pass.setDebugName('Main');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
            pass.exec((passRenderer) => {
                this.renderInstListMain.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
            });
        });
        this.renderHelper.antialiasingSupport.pushPasses(builder, viewerInput, mainColorTargetID);
        builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);

        this.prepareToRender(device, viewerInput);
        this.renderHelper.renderGraph.execute(builder);
        this.renderInstListMain.reset();
    }

    public destroy(device: GfxDevice): void {
        device.destroyInputLayout(this.inputLayout);
        device.destroyProgram(this.program);
        this.slyDumpRenderers.forEach((r) => r.destroy(device));
        this.renderHelper.destroy();
    }

    public createPanels(): UI.Panel[] {
        const layersPanel = new UI.LayerPanel();
        layersPanel.setLayers(this.slyDumpRenderers);
        return [layersPanel];
    }
}
