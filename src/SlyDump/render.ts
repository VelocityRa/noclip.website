import { mat4, vec3, vec4 } from 'gl-matrix';

import { DeviceProgram } from '../Program';
import * as Viewer from '../viewer';
import * as UI from '../ui';

import { GfxDevice, GfxBufferUsage, GfxBuffer, GfxInputState, GfxFormat, GfxInputLayout, GfxProgram, GfxBindingLayoutDescriptor, GfxRenderPass, GfxBindings, GfxVertexBufferFrequency, GfxVertexAttributeDescriptor, GfxInputLayoutBufferDescriptor, GfxCullMode, GfxBlendFactor, GfxBlendMode, GfxTexture, makeTextureDescriptor2D, GfxMipFilterMode, GfxTexFilterMode, GfxWrapMode } from '../gfx/platform/GfxPlatform';
import { fillColor, fillFloat, fillMatrix4x4, fillVec4, fillVec4v } from '../gfx/helpers/UniformBufferHelpers';
import { makeBackbufferDescSimple, pushAntialiasingPostProcessPass, standardFullClearRenderPassDescriptor } from '../gfx/helpers/RenderGraphHelpers';
import { makeStaticDataBuffer } from '../gfx/helpers/BufferHelpers';
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper';
import { GfxRendererLayer, GfxRenderInstManager, makeSortKey } from '../gfx/render/GfxRenderInstManager';
import { CameraController } from '../Camera';
import { GfxrAttachmentSlot } from '../gfx/render/GfxRenderGraph';
import { Red } from '../Color';
import { DumpChunk } from './bin';
import { setAttachmentStateSimple } from '../gfx/helpers/GfxMegaStateDescriptorHelpers';
import { interactiveVizSliderSelect } from '../DebugJunk';
import { TextureMapping } from '../TextureHolder';
import { DataFetcher } from '../DataFetcher';
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

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_Projection;
    Mat4x4 u_ModelView;
};

layout(std140) uniform ub_ObjectParams {
    vec4 vc17;
    vec4 vc18;
    vec4 vc19;
    vec4 vc29;
    Mat4x4 u_GameProjectionMat;
    float u_DrawType; // TODO: specify at compile time
};

layout(binding = 0) uniform sampler2D u_Texture;

varying vec3 v_Normal;
varying vec2 v_Texcoord;
varying vec4 v_Diff;
varying vec4 v_Spec;
varying vec3 v_AmbientColor;
varying float v_Depth;

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
    vec4 texcoordOffset = vc18;
    vec4 ambientColor = vc19;
    // vec4 vc29 = vc29;

    v_Normal = a_Normal;
    v_Diff = a_Diff * diffSpecMultiplier;
    v_Spec = a_Spec * diffSpecMultiplier;
    v_AmbientColor = ambientColor.rgb;

    if (u_DrawType == 4.0) { // Normal2
        v_Texcoord = a_Texcoord;
    } else {
        v_Texcoord = texcoordOffset.xy + a_Texcoord;
    }

    vec3 pos = a_Position.xzy * vec3(1.0, 1.0, -1.0);
    vec4 modelViewPos = Mul(u_ModelView, vec4(pos, 1.0));

    gl_Position = Mul(u_Projection, modelViewPos);

    // vec4 gameVertexPosition = Mul(u_GameProjectionMat, modelViewPos);
    // v_Depth = saturate((gameVertexPosition.z - vc29.x) * vc29.y) * vc29.w * 100.0;
    // v_Depth = (gameVertexPosition.z - vc29.x) / 1000.0;
    // v_Depth = gl_FragCoord.z * 1.0;
    // v_Depth = 0.0;
}
#endif

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
    // float originalZ = gl_FragCoord.z / gl_FragCoord.w;
    float c = gl_FragCoord.z * 1100.0;
    float depth = clamp(1.0 - c, 0.05, 0.7);

    // gl_FragColor = vec4(c, c, c, 1.0); return;
    // gl_FragColor = vec4(v_Depth, v_Depth, v_Depth, 1.0); return;

    vec4 diff_color = v_Diff;
    vec4 spec_color = v_Spec;

    // TODO
    vec4 fc80 = vec4(0.30, 0.59, 0.11, 0.0);

    vec4 h0 = vec4(0.);
    vec4 h1 = vec4(0.);
	vec4 h2 = vec4(0.);
	vec4 h3 = vec4(0.);

	h1 = texture(SAMPLER_2D(u_Texture), v_Texcoord);

    // gl_FragColor = h1; gl_FragColor.a = 1.0; return;
    // gl_FragColor = spec_color; gl_FragColor.a = 1.0; return;
    // gl_FragColor = spec_color.aaaa; gl_FragColor.a = 1.0; return;
    // gl_FragColor = diff_color; gl_FragColor.a = 1.0; return;
    // gl_FragColor = diff_color.aaaa; gl_FragColor.a = 1.0; return;

    if (u_DrawType == 2.0) { // Nospec
        h0 = saturate(diff_color);
        h0.xyz = ((h0 * h1) * 2.).xyz;
        h0.w = ((h0 * h1) * 2.).w;
        h1.xyz = v_AmbientColor - h0.rgb;
        h2.w = depth;
        h0.xyz = fma4(h2.wwww, h1, h0).xyz;
    } else { // if (u_DrawType == 0.0) { // Normal
        h2 = spec_color;
        h2.rgb = ((h1 * h2) * 2.).rgb;
        h0 = diff_color;
        h1.x = vec4(dot(h1.rgb, fc80.rgb)).x;
        // h0.a = ((h0 * h1) * 4.).a;
        h0.a = h0.a * h1.a * 2.0;

        // h3.a = v_Depth;
        h3.a = depth;

        h3.rgb = ((h0 * h1.xxxx) * 2.).rgb;
        h1.rgb = fma4(h3.aaaa, -h2, h2).rgb;
        h0.rgb = v_AmbientColor - h3.rgb;
        h0.rgb = (fma4(h3.aaaa, h0, h3) / 2.).rgb;
        h0.rgb = (fma4(h1, h2.aaaa, h0) * 2.).rgb;
    }

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

    public inputState: GfxInputState;

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

        this.inputState = device.createInputState(inputLayout, [
            { buffer: this.posBuffer, byteOffset: 0, },
            { buffer: this.nrmBuffer, byteOffset: 0, },
            { buffer: this.texcoordsBuffer, byteOffset: 0, },
            { buffer: this.diffBuffer, byteOffset: 0, },
            { buffer: this.specBuffer, byteOffset: 0, },
        ],
        { buffer: this.indexBuffer, byteOffset: 0 });

        this.numVertices = vertexData.positions.length;
    }

    public setVisible(v: boolean) {
        this.visible = v;
    }

    public prepareToRender(renderInstManager: GfxRenderInstManager): void {
        if (!this.visible)
            return;

        const template = renderInstManager.pushTemplateRenderInst();

        let offs = template.allocateUniformBuffer(SlyDumpProgram.ub_ObjectParams, 4*4 + 4*4 + 4);
        const d = template.mapUniformBufferF32(SlyDumpProgram.ub_ObjectParams);
        offs += fillVec4v(d, offs, this.dumpChunk.vc17);
        offs += fillVec4v(d, offs, this.dumpChunk.vc18);
        // TODO
        if (this.dumpChunk.drawType == 4.0) { // Normal2
            // const fc160 = vec4.fromValues(0.08235, 0.33333, 0.58824, 1.00); // intro?
            const fc160 = vec4.fromValues(0.09804, 0.08235, 0.07451, 1.00); // pirate
            offs += fillVec4v(d, offs, fc160);
        } else
            offs += fillVec4v(d, offs, this.dumpChunk.vc19);
        offs += fillVec4v(d, offs, this.dumpChunk.vc29);
        offs += fillMatrix4x4(d, offs, this.dumpChunk.projMatrix);
        offs += fillFloat(d, offs, this.dumpChunk.drawType);

        if (this.textureMapping) {
            template.setSamplerBindingsFromTextureMappings([this.textureMapping]);
        }

        const isSkydome = (this.dumpChunk.name.endsWith("_clr:1_blk:2"));

        let rendererLayer: GfxRendererLayer;
        if (this.dumpChunk.textureName == "0x703A2F08")
            rendererLayer = GfxRendererLayer.OPAQUE + 1;
        else if (isSkydome)
            rendererLayer = GfxRendererLayer.BACKGROUND;
        else if (this.dumpChunk.textureIsOpaque)
            rendererLayer = GfxRendererLayer.OPAQUE;
        else
            rendererLayer = GfxRendererLayer.TRANSLUCENT;

        template.sortKey = makeSortKey(rendererLayer);

        const renderInst = renderInstManager.newRenderInst();
        renderInst.setInputLayoutAndState(this.inputLayout, this.inputState);
        renderInst.drawIndexes(this.numIndices);
        renderInstManager.submitRenderInst(renderInst);

        renderInstManager.popTemplateRenderInst();
    }

    public destroy(device: GfxDevice): void {
        device.destroyBuffer(this.posBuffer);
        device.destroyBuffer(this.nrmBuffer);
        device.destroyBuffer(this.indexBuffer);
        device.destroyBuffer(this.texcoordsBuffer);
        device.destroyInputState(this.inputState);
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

    constructor(device: GfxDevice, dumpChunks: DumpChunk[], textures: Map<string, ImageData>) {
        this.program = device.createProgram(new SlyDumpProgram());

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
        this.inputLayout = device.createInputLayout({ vertexAttributeDescriptors, vertexBufferDescriptors, indexBufferFormat });

        this.renderHelper = new GfxRenderHelper(device);

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
        c.setSceneMoveSpeedMult(0.7);
    }

    private prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
        const template = this.renderHelper.pushTemplateRenderInst();
        template.setBindingLayouts(bindingLayouts);
        template.setGfxProgram(this.program);
        template.setMegaStateFlags(setAttachmentStateSimple({
            cullMode: GfxCullMode.None,
        }, {
            blendMode: GfxBlendMode.Add,
            blendSrcFactor: GfxBlendFactor.SrcAlpha,
            blendDstFactor: GfxBlendFactor.OneMinusSrcAlpha,
        }));

        viewerInput.camera.setClipPlanes(10, 300000);

        let offs = template.allocateUniformBuffer(SlyDumpProgram.ub_SceneParams, 32);
        const mapped = template.mapUniformBufferF32(SlyDumpProgram.ub_SceneParams);
        offs += fillMatrix4x4(mapped, offs, viewerInput.camera.projectionMatrix);
        offs += fillMatrix4x4(mapped, offs, viewerInput.camera.viewMatrix);

        for (let i = 0; i < this.slyDumpRenderers.length; i++)
            this.slyDumpRenderers[i].prepareToRender(this.renderHelper.renderInstManager);

        this.renderHelper.renderInstManager.popTemplateRenderInst();
        this.renderHelper.prepareToRender();
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput) {
        const renderInstManager = this.renderHelper.renderInstManager;

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
                renderInstManager.drawOnPassRenderer(passRenderer);
            });
        });
        pushAntialiasingPostProcessPass(builder, this.renderHelper, viewerInput, mainColorTargetID);
        builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);

        this.prepareToRender(device, viewerInput);
        this.renderHelper.renderGraph.execute(builder);
        renderInstManager.resetRenderInsts();
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
