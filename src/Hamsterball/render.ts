import { vec3 } from 'gl-matrix';

import { DeviceProgram } from '../Program';
import * as Viewer from '../viewer';
import * as UI from '../ui';

import { GfxDevice, GfxBufferUsage, GfxBuffer, GfxInputState, GfxFormat, GfxInputLayout, GfxProgram, GfxBindingLayoutDescriptor, GfxRenderPass, GfxBindings, GfxVertexBufferFrequency, GfxVertexAttributeDescriptor, GfxInputLayoutBufferDescriptor, GfxCullMode, makeTextureDescriptor2D, GfxMipFilterMode, GfxTexFilterMode, GfxTexture, GfxWrapMode, GfxBufferFrequencyHint, GfxBlendMode, GfxBlendFactor } from '../gfx/platform/GfxPlatform';
import { fillColor, fillFloat, fillMatrix4x4, fillVec4, fillVec4v } from '../gfx/helpers/UniformBufferHelpers';
import { GfxrAttachmentClearDescriptor, makeAttachmentClearDescriptor, makeBackbufferDescSimple, pushAntialiasingPostProcessPass, standardFullClearRenderPassDescriptor } from '../gfx/helpers/RenderGraphHelpers';
import { makeStaticDataBuffer } from '../gfx/helpers/BufferHelpers';
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper';
import { GfxRendererLayer, GfxRenderInstManager, makeSortKey } from '../gfx/render/GfxRenderInstManager';
import { setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers";
import { CameraController } from '../Camera';
import { GfxrAttachmentSlot } from '../gfx/render/GfxRenderGraph';
import { colorNewFromRGBA, Red } from '../Color';
import { MaterialEntry, MeshWorld, VertexData } from './bin';
import { TextureMapping } from '../TextureHolder';
import { SceneContext } from '../SceneBase';
import ArrayBufferSlice from '../ArrayBufferSlice';
import { DataFetcher } from '../DataFetcher';
import { convertToTrianglesRange, GfxTopology } from '../gfx/helpers/TopologyHelpers';
import { drawWorldSpacePoint, drawWorldSpaceVector, getDebugOverlayCanvas2D, interactiveVizSliderSelect } from '../DebugJunk';

// TODO:
// correct directional lighting
// mirrored support
// specular
// figure out second color in meshworld (just change it see results)
// submeshes
// animations

class HamsterballProgram extends DeviceProgram {
    public static a_Position = 0;
    public static a_Normal = 1;
    public static a_Texcoord = 2;
    public static a_MaterialId = 3;

    public static ub_SceneParams = 0;
    public static ub_ObjectParams = 1;

    public override both = `
precision mediump float;

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_Projection;
    Mat4x4 u_ModelView;
};

layout(std140) uniform ub_ObjectParams {
    vec4 u_Colors[4];
    float u_hasTex; // bool TODO: do at compile-time
    float u_isOpaque; // bool TODO: do at compile-time
};

layout(binding = 0) uniform sampler2D u_Texture;

varying vec2 v_Texcoord;
varying vec2 v_LightIntensity;
// varying vec3 v_MaterialColor;

#ifdef VERT
layout(location = ${HamsterballProgram.a_Position}) attribute vec3 a_Position;
layout(location = ${HamsterballProgram.a_Normal}) attribute vec3 a_Normal;
layout(location = ${HamsterballProgram.a_Texcoord}) attribute vec2 a_Texcoord;
// layout(location = ${HamsterballProgram.a_MaterialId}) attribute uint a_MaterialId;

void mainVS() {
    v_Texcoord = a_Texcoord;

    gl_Position = Mul(u_Projection, Mul(u_ModelView, vec4(a_Position, 1.0)));
    if (u_isOpaque == 0.0)
        gl_Position.y += 1.0;

    vec3 t_LightDirection = normalize(vec3(-.8, -1, .3));
    float t_LightIntensityF = dot(-a_Normal, t_LightDirection);
    float t_LightIntensityB = dot( a_Normal, t_LightDirection);
    v_LightIntensity = vec2(t_LightIntensityF, t_LightIntensityB);
    // v_MaterialColor = vec3(float(a_MaterialId >> 16) / 255.0);
}
#endif

#ifdef FRAG
void mainPS() {
    float t_LightIntensity = gl_FrontFacing ? v_LightIntensity.x : v_LightIntensity.y;
    float t_LightTint = 0.3 * t_LightIntensity;
    if (u_hasTex == 0.0) {
        // gl_FragColor = vec4(1.0);
        // gl_FragColor = u_Colors[0];
        // gl_FragColor = u_Colors[0] + vec4(t_LightTint, t_LightTint, t_LightTint, 0.0);

        gl_FragColor = u_Colors[0];
        // float light = t_LightIntensity; // (t_LightIntensity - 0.1) * 2.0;
        // float light = t_LightIntensity * 1.3 + 0.65;
        float light = t_LightIntensity * 2.0;
        gl_FragColor *= vec4(light, light, light, 1.0);
    } else {
        vec4 tex = texture(SAMPLER_2D(u_Texture), v_Texcoord.xy);
        gl_FragColor = u_Colors[0] * tex;
    }

    // gl_FragColor *= u_Colors[0];
    // gl_FragColor = vec4(0, 1, 0, 1);
}
#endif
`;
}

// TODO: Refactor. vertex buffers from meshWorld are duplicated! only diff thing is uniforms + indices (?)

export class HamsterballRenderer {
    public visible: boolean = true;
    public name: string;

    private numVertices: number;
    private posBuffer: GfxBuffer;
    private nrmBuffer: GfxBuffer;
    private texcoordsBuffer: GfxBuffer;
    // private materialIdBuffer: GfxBuffer;

    private indexBuffer: GfxBuffer;
    private indexBufferLen: number;

    private inputState: GfxInputState;

    constructor(device: GfxDevice, private meshWorld: MeshWorld, private materialEntry: MaterialEntry,
        private textureMapping: TextureMapping | undefined, private inputLayout: GfxInputLayout) {
        this.name = `${materialEntry.name}`;

        this.setVisible(!this.name.startsWith("E:"));

        const vertexData = meshWorld.vertexData;
        // const indexData = meshWorld.indexData;

        this.posBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Vertex, vertexData.positions.buffer);
        this.nrmBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Vertex, vertexData.normals.buffer);
        this.texcoordsBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Vertex, vertexData.texcoords.buffer);
        // this.materialIdBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Vertex, vertexData.materialIds.buffer);

        // HACKY
        // this.indexBuffer = device.createBuffer(1000, GfxBufferUsage.Index, GfxBufferFrequencyHint.Dynamic);

        let triListVertsSize = 0;
        for (let triStrip of this.materialEntry.triStripList) {
            let triStripSize = triStrip[1];
            let triStripVertsSize = triStripSize * 3;

            triListVertsSize += triStripVertsSize;
        }

        let triList = new Uint16Array(triListVertsSize);
        let triListIndex = 0;
        for (let triStrip of this.materialEntry.triStripList) {
            let triStripStart = triStrip[0];
            let triStripSize = triStrip[1];
            let triStripTrisSize = triStripSize + 2;

            convertToTrianglesRange(triList, triListIndex, GfxTopology.TriStrips, triStripStart, triStripTrisSize);
            // console.log(triList); //

            let triStripVertsSize = triStripSize * 3;
            triListIndex += triStripVertsSize;
        }

        this.indexBuffer = makeStaticDataBuffer(device, GfxBufferUsage.Index, triList.buffer);
        console.log(triList);
        this.indexBufferLen = triList.length;

        this.inputState = device.createInputState(inputLayout, [
            { buffer: this.posBuffer, byteOffset: 0, },
            { buffer: this.nrmBuffer, byteOffset: 0, },
            { buffer: this.texcoordsBuffer, byteOffset: 0, },
            // { buffer: this.materialIdBuffer, byteOffset: 0, },
        ],
        { buffer: this.indexBuffer, byteOffset: 0 });

        this.numVertices = vertexData.positions.length;
    }

    public setVisible(v: boolean) {
        this.visible = v;
    }

    public prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager): void {
        if (!this.visible)
            return;

        const template = renderInstManager.pushTemplateRenderInst();

        let offs = template.allocateUniformBuffer(HamsterballProgram.ub_ObjectParams, 4 * 4 + 1 + 1);
        const d = template.mapUniformBufferF32(HamsterballProgram.ub_ObjectParams);
        offs += fillVec4v(d, offs, this.materialEntry.colors[0]);
        offs += fillVec4v(d, offs, this.materialEntry.colors[1]);
        offs += fillVec4v(d, offs, this.materialEntry.colors[2]);
        offs += fillVec4v(d, offs, this.materialEntry.colors[3]);
        offs += fillFloat(d, offs, this.materialEntry.hasTex ? 1.0 : 0.0);
        offs += fillFloat(d, offs, this.materialEntry.isOpaque ? 1.0 : 0.0);

        if (this.textureMapping) {
            template.setSamplerBindingsFromTextureMappings([this.textureMapping]);
        }

        template.setInputLayoutAndState(this.inputLayout, this.inputState);

        let rendererLayer = this.materialEntry.isOpaque ? GfxRendererLayer.OPAQUE : GfxRendererLayer.TRANSLUCENT;
        template.sortKey = makeSortKey(rendererLayer);

        // for (let triList of this.triLists) {
        //     const renderInst = renderInstManager.newRenderInst();
        //     debugger;
        //     // device.uploadBufferData(this.indexBuffer, 0, (new ArrayBufferSlice(triList)).createTypedArray(Uint8Array));
        //     renderInst.drawIndexes(triList.length);
        //     renderInstManager.submitRenderInst(renderInst);
        // }

        const renderInst = renderInstManager.newRenderInst();
        renderInst.drawIndexes(this.indexBufferLen);
        renderInstManager.submitRenderInst(renderInst);

        renderInstManager.popTemplateRenderInst();
    }

    public destroy(device: GfxDevice): void {
        // this.chunks.forEach((chunk) => chunk.destroy(device));
        device.destroyBuffer(this.posBuffer);
        device.destroyBuffer(this.nrmBuffer);
        device.destroyBuffer(this.indexBuffer);
        device.destroyBuffer(this.texcoordsBuffer);
        // device.destroyBuffer(this.materialIdBuffer);
        device.destroyInputState(this.inputState);
    }
}

const bindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 2, numSamplers: 1 }, // ub_SceneParams
];

// TODO: move to common (copied from foxfur)
function fetchImage(dataFetcher: DataFetcher, path: string): Promise<ImageData> {
    path = dataFetcher.getDataURLForPath(path);
    const img = document.createElement('img');
    img.crossOrigin = 'anonymous';
    img.src = path;
    const p = new Promise<ImageData>((resolve) => {
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(img, 0, 0);
            resolve(ctx.getImageData(0, 0, img.width, img.height));
        };
    });
    return p;
}

function makeTextureFromImageData(device: GfxDevice, imageData: ImageData): GfxTexture {
    const texture = device.createTexture(makeTextureDescriptor2D(GfxFormat.U8_RGBA_NORM, imageData.width, imageData.height, 1));
    device.uploadTextureData(texture, 0, [new Uint8Array(imageData.data.buffer)]);
    return texture;
}

export class Scene implements Viewer.SceneGfx {
    private inputLayout: GfxInputLayout;
    private program: GfxProgram;

    private hamsterballRenderers: HamsterballRenderer[] = [];
    private textureMappings: Map<string, TextureMapping> = new Map();

    private renderHelper: GfxRenderHelper;
    private fullClearRenderPassDescriptor: GfxrAttachmentClearDescriptor;

    constructor(private device: GfxDevice, private context: SceneContext, public meshWorld: MeshWorld) {
        this.program = device.createProgram(new HamsterballProgram());

        const vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [
            { location: HamsterballProgram.a_Position,   bufferIndex: 0, bufferByteOffset: 0, format: GfxFormat.F32_RGB, },
            { location: HamsterballProgram.a_Normal,     bufferIndex: 1, bufferByteOffset: 0, format: GfxFormat.F32_RGB, },
            { location: HamsterballProgram.a_Texcoord,   bufferIndex: 2, bufferByteOffset: 0, format: GfxFormat.F32_RG, },
            // { location: HamsterballProgram.a_MaterialId, bufferIndex: 3, bufferByteOffset: 0, format: GfxFormat.U32_R, },
        ];
        const vertexBufferDescriptors: GfxInputLayoutBufferDescriptor[] = [
            { byteStride: 3*0x04, frequency: GfxVertexBufferFrequency.PerVertex, },
            { byteStride: 3*0x04, frequency: GfxVertexBufferFrequency.PerVertex, },
            { byteStride: 2*0x04, frequency: GfxVertexBufferFrequency.PerVertex, },
            // { byteStride: 1*0x04, frequency: GfxVertexBufferFrequency.PerVertex, },
        ];
        const indexBufferFormat = GfxFormat.U16_R;
        this.inputLayout = device.createInputLayout({ vertexAttributeDescriptors, vertexBufferDescriptors, indexBufferFormat });

        const bgColor = meshWorld.bgColor;
        const bcColorGfx = colorNewFromRGBA(bgColor[0], bgColor[1], bgColor[2], 1.0);
        this.fullClearRenderPassDescriptor = makeAttachmentClearDescriptor(bcColorGfx);
    }

    public async init() {
        const samplerPoint = this.device.createSampler({
            wrapS: GfxWrapMode.Repeat,
            wrapT: GfxWrapMode.Repeat,
            minFilter: GfxTexFilterMode.Point,
            magFilter: GfxTexFilterMode.Point,
            mipFilter: GfxMipFilterMode.Nearest,
            minLOD: 0, maxLOD: 0,
        });
        const samplerBilinear = this.device.createSampler({
            wrapS: GfxWrapMode.Repeat,
            wrapT: GfxWrapMode.Repeat,
            minFilter: GfxTexFilterMode.Bilinear,
            magFilter: GfxTexFilterMode.Bilinear,
            mipFilter: GfxMipFilterMode.Nearest,
            minLOD: 0, maxLOD: 0,
        });

        let textureIsOpaqueInfo = new Map<string, boolean>();
        const textureNames = this.meshWorld.allTriStripLists.keys();
        for (let textureName of textureNames) {
            if (textureName.endsWith(".bmp") || textureName.endsWith(".png")) {
                const texturePath = `Hamsterball/Textures/${textureName}`; // TODO: don't hardcode path
                let imageData = await fetchImage(this.context.dataFetcher, texturePath);

                let usePointFiltering = true;
                // Figure out its filtering mode
                // Assumes filtering is the same for all material entries of the same texture image
                // for (const material of this.meshWorld.materialEntries) {
                //     if (material.name == textureName) {
                //         usePointFiltering = material.usePointFiltering;
                //         break;
                //     }
                // }
                usePointFiltering = textureName.includes("Checker");

                let textureMapping = new TextureMapping();
                textureMapping.gfxTexture = makeTextureFromImageData(this.device, imageData);
                if (usePointFiltering)
                    textureMapping.gfxSampler = samplerPoint;
                else
                    textureMapping.gfxSampler = samplerBilinear;
                textureMapping.width = imageData.width;
                textureMapping.height = imageData.height;
                this.textureMappings.set(textureName, textureMapping);

                let isOpaque = true;
                for (let i = 3; i < imageData.data.length; i += 4) {
                    if (imageData.data[i] != 0xFF) {
                        isOpaque = false;
                        break;
                    }
                }
                textureIsOpaqueInfo.set(textureName, isOpaque);
            }
        }

        this.hamsterballRenderers = this.meshWorld.materialEntries.map((materialEntry) => {
            const textureMapping = this.textureMappings.get(materialEntry.name);
            const isOpaque = textureIsOpaqueInfo.get(materialEntry.name);
            materialEntry.isOpaque = isOpaque!;
            return new HamsterballRenderer(this.device, this.meshWorld, materialEntry, textureMapping, this.inputLayout);
        });

        this.renderHelper = new GfxRenderHelper(this.device);
    }

    // For debugging
    public objectSelect(): void {
        interactiveVizSliderSelect(this.hamsterballRenderers, 'visible', (instance) => {
            console.log(instance);
        });
    }

    public adjustCameraController(c: CameraController) {
        c.setSceneMoveSpeedMult(0.25);
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

        let offs = template.allocateUniformBuffer(HamsterballProgram.ub_SceneParams, 32);
        const mapped = template.mapUniformBufferF32(HamsterballProgram.ub_SceneParams);
        offs += fillMatrix4x4(mapped, offs, viewerInput.camera.projectionMatrix);
        offs += fillMatrix4x4(mapped, offs, viewerInput.camera.viewMatrix);

        for (let i = 0; i < this.hamsterballRenderers.length; i++) {
            this.hamsterballRenderers[i].prepareToRender(device, this.renderHelper.renderInstManager);
        }

        this.renderHelper.renderInstManager.popTemplateRenderInst();
        this.renderHelper.prepareToRender();
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput) {
        const renderInstManager = this.renderHelper.renderInstManager;

        const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, this.fullClearRenderPassDescriptor);
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

        const ctx = getDebugOverlayCanvas2D();
        // drawWorldSpacePoint(ctx, viewerInput.camera.clipFromWorldMatrix, [1935.884, 	418.117, 	-1540.019]);
        // drawWorldSpacePoint(ctx, viewerInput.camera.clipFromWorldMatrix, [1468.527, 	418.117, 	-1148.344]);
        // drawWorldSpacePoint(ctx, viewerInput.camera.clipFromWorldMatrix, [779.010, 	418.117, 	-443.763]);
        // drawWorldSpacePoint(ctx, viewerInput.camera.clipFromWorldMatrix, [-21.587, 	418.117, 	417.271]);

        let dir = vec3.fromValues(-.5, -1, .2);
        vec3.normalize(dir, dir);
        drawWorldSpaceVector(ctx, viewerInput.camera.clipFromWorldMatrix, [0,0,0], dir, 1000);

        this.prepareToRender(device, viewerInput);
        this.renderHelper.renderGraph.execute(builder);
        renderInstManager.resetRenderInsts();
    }

    public destroy(device: GfxDevice): void {
        device.destroyInputLayout(this.inputLayout);
        device.destroyProgram(this.program);
        this.hamsterballRenderers.forEach((r) => r.destroy(device));
        this.renderHelper.destroy();
    }

    public createPanels(): UI.Panel[] {
        const layersPanel = new UI.LayerPanel();
        layersPanel.setLayers(this.hamsterballRenderers);
        return [layersPanel];
    }
}