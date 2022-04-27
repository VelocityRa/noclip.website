import { vec3 } from 'gl-matrix';

import { DeviceProgram } from '../Program';
import * as Viewer from '../viewer';
import * as UI from '../ui';

import { GfxDevice, GfxBufferUsage, GfxBuffer, GfxInputState, GfxFormat, GfxInputLayout, GfxProgram, GfxBindingLayoutDescriptor, GfxRenderPass, GfxBindings, GfxVertexBufferFrequency, GfxVertexAttributeDescriptor, GfxInputLayoutBufferDescriptor, GfxCullMode, GfxBlendFactor, GfxBlendMode, GfxTexture, makeTextureDescriptor2D, GfxMipFilterMode, GfxTexFilterMode, GfxWrapMode } from '../gfx/platform/GfxPlatform';
import { fillColor, fillMatrix4x4 } from '../gfx/helpers/UniformBufferHelpers';
import { makeBackbufferDescSimple, pushAntialiasingPostProcessPass, standardFullClearRenderPassDescriptor } from '../gfx/helpers/RenderGraphHelpers';
import { makeStaticDataBuffer } from '../gfx/helpers/BufferHelpers';
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper';
import { GfxRenderInstManager } from '../gfx/render/GfxRenderInstManager';
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
    // float nearPlane;
    // float farPlane;
    vec4 dummy;
};

layout(binding = 0) uniform sampler2D u_Texture;

varying vec3 v_Normal;
varying vec2 v_Texcoord;
varying vec4 v_Diff;
varying vec4 v_Spec;

#ifdef VERT
layout(location = ${SlyDumpProgram.a_Position}) attribute vec3 a_Position;
layout(location = ${SlyDumpProgram.a_Normal}) attribute vec3 a_Normal;
layout(location = ${SlyDumpProgram.a_Texcoord}) attribute vec2 a_Texcoord;
layout(location = ${SlyDumpProgram.a_Diff}) attribute vec4 a_Diff;
layout(location = ${SlyDumpProgram.a_Spec}) attribute vec4 a_Spec;

void mainVS() {
    v_Normal = a_Normal;
    v_Texcoord = a_Texcoord;
    v_Diff = a_Diff;
    v_Spec = a_Spec;

    const float t_ModelScale = 1.0;
    gl_Position = Mul(u_Projection, Mul(u_ModelView, vec4(a_Position * t_ModelScale, 1.0)));
}
#endif

#ifdef FRAG

vec4 fma4(vec4 a, vec4 b, vec4 c) {
    return a * b + c;
}

void mainPS() {
    // vec4 tex = texture(SAMPLER_2D(u_Texture), v_Texcoord);
    // gl_FragColor = tex;

    // gl_FragColor = vec4(v_Diff.rgb, 1.0);
    // gl_FragColor = vec4(v_Diff.aaa, 1.0);
    // gl_FragColor = vec4(v_Spec.rgb, 1.0);
    // gl_FragColor = vec4(v_Spec.aaa, 1.0);

    // gl_FragColor.rgb = vec3(v_Texcoord.x, v_Texcoord.y, 0.0);
    // gl_FragColor.rgb = vec3(v_Normal.x, v_Normal.y, v_Normal.z);
    // gl_FragColor.a = 1.0; // TODO


    vec4 diff_color = v_Diff;
    vec4 spec_color = v_Spec;

    vec4 fc80 = vec4(0.30, 0.59, 0.11, 0.0);
    vec4 tc1 = vec4(0.08235, 0.33333, 0.58824, 1.00);

    vec4 h0 = vec4(0.);
    vec4 h1 = vec4(0.);
	vec4 h2 = vec4(0.);
	vec4 h3 = vec4(0.);

	h1 = texture(SAMPLER_2D(u_Texture), v_Texcoord);
	h2 = spec_color;
	h2.xyz = ((h1 * h2) * 2.).xyz;
	h0 = diff_color;
	h1.x = vec4(dot(h1.xyz, fc80.xyz)).x;
	// h0.w = ((h0 * h1) * 4.).w;
	h0.w = ((h0 * h1) * 2.).w;
	// h3.w = v_Texcoord.zzzz.w;
	h3.w = 0.0;
	h3.xyz = ((h0 * h1.xxxx) * 2.).xyz;
	h1.xyz = fma4(h3.wwww, -h2, h2).xyz;
	h0.xyz = (tc1 + -h3).xyz;
	h0.xyz = (fma4(h3.wwww, h0, h3) / 2.).xyz;
	h0.xyz = (fma4(h1, h2.wwww, h0) * 2.).xyz;


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

        let offs = template.allocateUniformBuffer(SlyDumpProgram.ub_ObjectParams, 4);
        const d = template.mapUniformBufferF32(SlyDumpProgram.ub_ObjectParams);
        offs += fillColor(d, offs, Red);

        if (this.textureMapping) {
            template.setSamplerBindingsFromTextureMappings([this.textureMapping]);
        }

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
        c.setSceneMoveSpeedMult(.01);
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

        // TODO: check if fog is different depending on this
        viewerInput.camera.setClipPlanes(0.1, 3000);

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
