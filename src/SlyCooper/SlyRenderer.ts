import * as Viewer from '../viewer';
import * as UI from '../ui';
import { FakeTextureHolder } from '../TextureHolder';
import { GfxDevice, GfxRenderPass, GfxBindingLayoutDescriptor, GfxHostAccessPass, GfxMegaStateDescriptor, GfxCullMode, GfxFrontFaceMode, GfxBlendMode, GfxBlendFactor, GfxSampler, GfxTexture, GfxWrapMode, GfxTexFilterMode, GfxMipFilterMode, GfxProgramDescriptorSimple, makeTextureDescriptor2D } from "../gfx/platform/GfxPlatform";
import { preprocessProgramObj_GLSL, DefineMap } from "../gfx/shaderc/GfxShaderCompiler";
import { GfxRenderHelper } from "../gfx/render/GfxRenderGraph";
import { BasicRenderTarget, standardFullClearRenderPassDescriptor } from "../gfx/helpers/RenderTargetHelpers";
import { GfxRenderInstManager, GfxRendererLayer, makeSortKeyOpaque } from "../gfx/render/GfxRenderer";
import { fillMatrix4x4, fillMatrix4x3, fillVec4, fillVec4v } from "../gfx/helpers/UniformBufferHelpers";
import { mat4, vec3, vec2, vec4 } from "gl-matrix";
import { computeViewMatrix, CameraController } from "../Camera";
import { nArray, assertExists, hexzero0x } from "../util";
import { TextureMapping } from "../TextureHolder";
import { MathConstants, scaleMatrix } from "../MathHelpers";
import { AABB } from "../Geometry";
import { setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers";
import * as Data from "./SlyData";
import { drawWorldSpaceAABB, getDebugOverlayCanvas2D, drawWorldSpacePoint } from "../DebugJunk";
import { Color, Magenta, colorToCSS, Red, Green, Blue, Cyan } from "../Color";

class SlyRenderHacks {
    disableTextures = false;
    disableVertexColors = false;
    // disableLighting = false;
}

class SlyDebugHacks {
    drawMeshOrigins = false;
    drawSzmsPositions = false;
    drawSzmePositions = false;
}

class SlyProgram {
    public static ub_SceneParams = 0;
    public static ub_ShapeParams = 1;

    public both = `
layout(row_major, std140) uniform ub_SceneParams {
    Mat4x4 u_Projection;
};

layout(row_major, std140) uniform ub_ShapeParams {
    Mat4x3 u_BoneMatrix[1];
};

// #define u_BaseDiffuse (u_Misc[0].x)
// #define u_BaseAmbient (u_Misc[0].y)

#define u_BaseDiffuse 1.0
#define u_BaseAmbient 0.2

uniform sampler2D u_Texture[1];

//#define u_AmbientTexture u_Texture[0];
//#define u_DiffuseTexture u_Texture[1];
//#define u_UnkTexture u_Texture[2];
`;

    public vert: string = `
layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec3 a_Normal;
layout(location = 2) in vec2 a_TexCoord;
layout(location = 3) in vec4 a_VertexColor;

out vec3 v_Normal;
out vec2 v_TexCoord;
out vec3 v_VertexColor;

void main() {
    gl_Position = Mul(u_Projection, Mul(_Mat4x4(u_BoneMatrix[0]), vec4(a_Position, 1.0)));
    v_Normal = normalize(vec4(a_Normal, 0.0).xyz);

    // gl_Position = Mul(u_Projection, vec4(a_Position, 1.0));
    // v_Normal = normalize(vec4(a_Normal, 0.0).xyz);
    v_TexCoord = a_TexCoord.xy;
    v_VertexColor = a_VertexColor.rgb;
}
`;

    public frag: string = `
in vec2 v_TexCoord;
in vec3 v_Normal;
in vec3 v_VertexColor;

void main() {
    vec2 t_DiffuseTexCoord = mod(v_TexCoord, vec2(1.0, 1.0));

#if ENABLE_TEXTURES
    vec3 t_DiffuseMapColor = texture(SAMPLER_2D(u_Texture[0]), t_DiffuseTexCoord.xy).rgb;
    // TODO: this is probably wrong (artifacts can be seen)
    // vec4 t_AmbientMapColor = texture(SAMPLER_2D(u_AmbientTexture), t_DiffuseTexCoord.xy);
    vec4 t_AmbientMapColor = vec4(1.0);
#else
    vec3 t_DiffuseMapColor = vec3(1.0);
    vec4 t_AmbientMapColor = vec4(1.0);
#endif

    // float t_LightFalloff = clamp(dot(u_LightDirection.xyz, v_Normal.xyz), 0.0, 1.0);
    // float t_Illum = clamp(t_LightFalloff + u_BaseAmbient, 0.0, 1.0);

    // gl_FragColor.rgb = t_Illum * t_DiffuseMapColor.rgb;
    // gl_FragColor.a = t_DiffuseMapColor.a;

    // gl_FragColor = vec4(t_DiffuseTexCoord, 0.0, 1.0);

    // gl_FragColor = vec4(v_Normal, 1.0);

    // gl_FragColor.rgb = t_DiffuseMapColor.rgb;
    // gl_FragColor.a = 1.0;

#if ENABLE_VERTEX_COLORS
    vec3 vertexColor = v_VertexColor;
#else
    vec3 vertexColor = vec3(1.0);
#endif

    // gl_FragColor.rgb = vertexColor * t_DiffuseMapColor;

    vec3 lightDirection = normalize(vec3(0.1027, 0.02917, 0.267));
    vec3 lightColor = vec3(10./255., 23./255., 26./255.) * 1.2;

    float ambientLambert = clamp(max(dot(v_Normal.xyz, lightDirection), 0.0), 0.0, 1.0);
    vec3 ambient = lightColor * ambientLambert * t_AmbientMapColor.rgb;

    gl_FragColor.rgb = ambient + t_DiffuseMapColor * vertexColor;
    gl_FragColor.a = 1.0;
}
`;

    public defines: DefineMap = new Map<string, string>();

    constructor(renderHacks: SlyRenderHacks) {
        let boolToStr = (value: boolean) => {
            return value ? "0" : "1";
        };

        this.defines.set("ENABLE_TEXTURES", boolToStr(renderHacks.disableTextures));
        this.defines.set("ENABLE_VERTEX_COLORS", boolToStr(renderHacks.disableVertexColors));
    }
}

const bindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 2, numSamplers: 1, },
];

const modelViewScratch = mat4.create();

export class SlyRenderer implements Viewer.SceneGfx {
    public textureHolder = new FakeTextureHolder([]);

    private program: (GfxProgramDescriptorSimple | null) = null;
    private renderTarget = new BasicRenderTarget();
    private renderHelper: GfxRenderHelper;
    private modelMatrix: mat4 = mat4.create();
    private meshRenderers: SlyMeshRenderer[] = [];

    private renderHacks: SlyRenderHacks = new SlyRenderHacks();
    private debugHacks: SlyDebugHacks = new SlyDebugHacks();

    private createShader(device: GfxDevice) {
        this.program = preprocessProgramObj_GLSL(device, new SlyProgram(this.renderHacks));
    }

    constructor(device: GfxDevice, meshes: Data.Mesh[], textures: (Data.Texture | null)[]) {
        this.renderHelper = new GfxRenderHelper(device);

        const gfxCache = this.renderHelper.getCache();

        for (let mesh of meshes) {
            for (let meshChunk of mesh.chunks) {
                const geometryData = new GeometryData(device, gfxCache, meshChunk);
                let textureData: (TextureData | null) = null;
                if (meshChunk.szme) {
                    const texture = textures[meshChunk.szme.texIndex];
                    if (texture) {
                        // console.log(`mesh at ${hexzero0x(mesh.offset)} gets texID ${hexzero0x(meshChunk.szme.texIndex)}`);
                        textureData = new TextureData(device, gfxCache, texture)
                    }
                }
                const meshRenderer = new SlyMeshRenderer(textureData, geometryData, meshChunk);

                this.meshRenderers.push(meshRenderer);
            }
        }
    }

    public prepareToRender(device: GfxDevice, hostAccessPass: GfxHostAccessPass, viewerInput: Viewer.ViewerRenderInput, renderInstManager: GfxRenderInstManager) {
        const template = this.renderHelper.pushTemplateRenderInst();
        template.setBindingLayouts(bindingLayouts);

        if (!this.program)
            this.createShader(device);
        const gfxProgram = renderInstManager.gfxRenderCache.createProgramSimple(device, this.program!);
        template.setGfxProgram(gfxProgram);

        let offs = template.allocateUniformBuffer(SlyProgram.ub_SceneParams, 16);
        const d = template.mapUniformBufferF32(SlyProgram.ub_SceneParams);
        offs += fillMatrix4x4(d, offs, viewerInput.camera.projectionMatrix);

        for (let meshRenderer of this.meshRenderers) {
            meshRenderer.prepareToRender(renderInstManager, viewerInput);
        }

        renderInstManager.popTemplateRenderInst();

        this.renderHelper.prepareToRender(device, hostAccessPass);
    }

    public render(device: GfxDevice, renderInput: Viewer.ViewerRenderInput): GfxRenderPass {
        const hostAccessPass = device.createHostAccessPass();
        const renderInstManager = this.renderHelper.renderInstManager;

        this.prepareToRender(device, hostAccessPass, renderInput, renderInstManager);
        device.submitPass(hostAccessPass);

        this.renderTarget.setParameters(device, renderInput.backbufferWidth, renderInput.backbufferHeight);
        const passRenderer = this.renderTarget.createRenderPass(device, renderInput.viewport, standardFullClearRenderPassDescriptor);
        renderInstManager.drawOnPassRenderer(device, passRenderer);
        renderInstManager.resetRenderInsts();

        if (this.debugHacks.drawMeshOrigins || this.debugHacks.drawSzmsPositions || this.debugHacks.drawSzmePositions) {
            const ctx = getDebugOverlayCanvas2D();

            for (let meshRenderer of this.meshRenderers) {
                if (this.debugHacks.drawSzmsPositions) {
                    let posVec = meshRenderer.meshChunk.positions;
                    for (let i = 0; i < posVec.length; i += 3) {
                        const p = vec3.fromValues(posVec[i + 0], posVec[i + 2], -posVec[i + 1]);
                        drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, p, Magenta, 5);
                    }
                }

                if (meshRenderer.meshChunk.szme) {
                    if (this.debugHacks.drawMeshOrigins) {
                        let origin = meshRenderer.meshChunk.szme?.origin;
                        let originVec = vec3.fromValues(origin[0], origin[2], -origin[1]);
                        drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, originVec, Green, 9);
                    }

                    if (this.debugHacks.drawSzmePositions) {
                        let posVec = meshRenderer.meshChunk.szme.positions;
                        for (let i = 0; i < posVec.length; i += 3) {
                            const p = vec3.fromValues(posVec[i + 0], posVec[i + 2], -posVec[i + 1]);
                            drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, p, Cyan, 7);

                        }
                    }
                }
            }
        }

        // let aabb = new AABB(-1000, -5000, -1000, 100, 5000, 100);
        // const ctx = getDebugOverlayCanvas2D();
        // drawWorldSpaceAABB(ctx, renderInput.camera.clipFromWorldMatrix, aabb);

        // const dbgPos = this.meshRenderers[148].meshChunk.szme?.positions!;
        // for (let i = 0; i < dbgPos.length; i += 3) {
        //     const p = vec3.fromValues(dbgPos[i + 0], dbgPos[i + 2], -dbgPos[i + 1]);
        //     drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, p, Magenta, 50);
        //     // console.log(`${p}`);
        // }
        // dbgPos = this.meshRenderers[148].meshChunk.positions!;
        // for (let i = 0; i < dbgPos.length; i += 3) {
        //     const p = vec3.fromValues(dbgPos[i + 0], dbgPos[i + 2], -dbgPos[i + 1]);
        //     drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, p, Cyan, 20);
        //     // console.log(`${p}`);
        // }

        // for (let meshRenderer of this.meshRenderers) {
            // let dbgPos = meshRenderer.meshChunk.positions;
            // for (let i = 0; i < dbgPos.length; i += 3) {
            //     const p = vec3.fromValues(dbgPos[i + 0], dbgPos[i + 2], -dbgPos[i + 1]);
            //     drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, p, Magenta, 13);
            // }

            // if (meshRenderer.meshChunk.szme) {
                // let orig = meshRenderer.meshChunk.szme?.origin;
                // let dbgPos = vec3.fromValues(orig[0], orig[2], -orig[1]);
                // drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, dbgPos, Green, 7);

                // dbgPos = meshRenderer.meshChunk.szme.positions;
                // for (let i = 0; i < dbgPos.length; i += 3) {
                //     const p = vec3.fromValues(dbgPos[i + 0], dbgPos[i + 2], -dbgPos[i + 1]);
                //     drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, p, Cyan, 4);

                // }
            // }
        // }

        return passRenderer;
    }

    private setTexturesEnabled(enabled: boolean) {
        this.renderHacks.disableTextures = !enabled;
        this.program = null;
    }

    private setVertexColorsEnabled(enabled: boolean) {
        this.renderHacks.disableVertexColors = !enabled;
        this.program = null;
    }

    public createPanels(): UI.Panel[] {
        const panels: UI.Panel[] = [];

        const renderHacksPanel = new UI.Panel();
        renderHacksPanel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;
        renderHacksPanel.setTitle(UI.RENDER_HACKS_ICON, 'Render Hacks');
        const enableVertexColorsCheckbox = new UI.Checkbox('Enable Vertex Colors', true);
        enableVertexColorsCheckbox.onchanged = () => {
            this.setVertexColorsEnabled(enableVertexColorsCheckbox.checked);
        };
        renderHacksPanel.contents.appendChild(enableVertexColorsCheckbox.elem);
        const enableTextures = new UI.Checkbox('Enable Textures', true);
        enableTextures.onchanged = () => {
            this.setTexturesEnabled(enableTextures.checked);
        };
        renderHacksPanel.contents.appendChild(enableTextures.elem);
        panels.push(renderHacksPanel);

        const debugPanel = new UI.Panel();
        debugPanel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;
        debugPanel.setTitle(UI.RENDER_HACKS_ICON, 'Debugging Hacks');
        const drawMeshOriginsCheckbox = new UI.Checkbox('Draw Mesh Origins', false);
        drawMeshOriginsCheckbox.onchanged = () => {
            this.debugHacks.drawMeshOrigins = drawMeshOriginsCheckbox.checked;
        };
        debugPanel.contents.appendChild(drawMeshOriginsCheckbox.elem);
        const drawSzmsPositionsCheckbox = new UI.Checkbox('Draw SZMS Positions', false);
        drawSzmsPositionsCheckbox.onchanged = () => {
            this.debugHacks.drawSzmsPositions = drawSzmsPositionsCheckbox.checked;
        };
        debugPanel.contents.appendChild(drawSzmsPositionsCheckbox.elem);
        const drawSzmePositionsCheckbox = new UI.Checkbox('Draw SZME Positions', false);
        drawSzmePositionsCheckbox.onchanged = () => {
            this.debugHacks.drawSzmePositions = drawSzmePositionsCheckbox.checked;
        };
        debugPanel.contents.appendChild(drawSzmePositionsCheckbox.elem);
        panels.push(debugPanel);

        return panels;
    }

    public destroy(device: GfxDevice): void {
        this.renderHelper.destroy(device);
        this.renderTarget.destroy(device);
    }
}

import { GfxBuffer, GfxInputLayout, GfxInputState, GfxBufferUsage, GfxVertexAttributeDescriptor, GfxFormat, GfxInputLayoutBufferDescriptor, GfxVertexBufferFrequency } from "../gfx/platform/GfxPlatform";
import { makeStaticDataBuffer } from "../gfx/helpers/BufferHelpers";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";

export interface VertexAttributes {
    position: vec3;
    normal: vec3;
    texcoord: vec2;
}

export interface IndexedPrimitives<T> {
    vertices: T[];
    indices: number[];
}

export class GeometryData {
    private indexBuffer: GfxBuffer;
    private positionBuffer: GfxBuffer;
    private normalBuffer: GfxBuffer;
    private texcoordBuffer: GfxBuffer;
    private vertexColorBuffer: GfxBuffer;
    public indexCount: number;
    public inputLayout: GfxInputLayout;
    public inputState: GfxInputState;

    // constructor(device: GfxDevice, cache: GfxRenderCache, geometry: Sly_ShaderInstancedIndexedPrimitives<Sly_VertexPositionNormalTextureInstance>) {
    // constructor(device: GfxDevice, cache: GfxRenderCache, geometry: IndexedPrimitives<VertexAttributes>) {
    constructor(device: GfxDevice, cache: GfxRenderCache, meshChunk: Data.MeshChunk) {
        const indices = Uint16Array.from(meshChunk.trianglesIndices);
        this.indexCount = indices.length;
        this.positionBuffer = makeStaticDataBuffer(device, GfxBufferUsage.VERTEX, meshChunk.positions.buffer);
        this.normalBuffer = makeStaticDataBuffer(device, GfxBufferUsage.VERTEX, meshChunk.normals.buffer);
        this.texcoordBuffer = makeStaticDataBuffer(device, GfxBufferUsage.VERTEX, meshChunk.texCoords.buffer);
        // let lighting: Float32Array;
        // if (meshChunk.szme)
        //     lighting = meshChunk.szme.lightingFloats;
        // else
        //     lighting = new Float32Array(meshChunk.positions.length * 4);
        // let lighting = new Float32Array(meshChunk.positions.length * 4);
        let vertexColor = meshChunk.vertexColorFloats;
        this.vertexColorBuffer = makeStaticDataBuffer(device, GfxBufferUsage.VERTEX, vertexColor.buffer);
        this.indexBuffer = makeStaticDataBuffer(device, GfxBufferUsage.INDEX, meshChunk.trianglesIndices.buffer);

        const vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [
            { location: 0, bufferIndex: 0, format: GfxFormat.F32_RGB, bufferByteOffset: 0, }, // Position
            { location: 1, bufferIndex: 1, format: GfxFormat.F32_RGB, bufferByteOffset: 0, }, // Normal
            { location: 2, bufferIndex: 2, format: GfxFormat.F32_RG,  bufferByteOffset: 0, }, // TexCoord
            { location: 3, bufferIndex: 3, format: GfxFormat.F32_RGBA,bufferByteOffset: 0, }, // VertexColor
        ];
        const vertexBufferDescriptors: GfxInputLayoutBufferDescriptor[] = [
            { byteStride: 3*0x04, frequency: GfxVertexBufferFrequency.PER_VERTEX, },
            { byteStride: 3*0x04, frequency: GfxVertexBufferFrequency.PER_VERTEX, },
            { byteStride: 2*0x04, frequency: GfxVertexBufferFrequency.PER_VERTEX, },
            { byteStride: 4*0x04, frequency: GfxVertexBufferFrequency.PER_VERTEX, },
        ];
        this.inputLayout = cache.createInputLayout(device, {
            indexBufferFormat: GfxFormat.U16_R,
            vertexAttributeDescriptors,
            vertexBufferDescriptors,
        });
        this.inputState = device.createInputState(this.inputLayout, [
            { buffer: this.positionBuffer, byteOffset: 0, },
            { buffer: this.normalBuffer, byteOffset: 0, },
            { buffer: this.texcoordBuffer, byteOffset: 0, },
            { buffer: this.vertexColorBuffer, byteOffset: 0, },
        ],
        { buffer: this.indexBuffer, byteOffset: 0 });
    }

    public destroy(device: GfxDevice): void {
        device.destroyBuffer(this.indexBuffer);
        device.destroyBuffer(this.positionBuffer);
        device.destroyBuffer(this.normalBuffer);
        device.destroyBuffer(this.texcoordBuffer);
        device.destroyInputState(this.inputState);
    }
}

class TextureData {
    public texture: GfxTexture;
    public sampler: GfxSampler;

    private makeGfxTexture(device: GfxDevice, texture: Data.Texture): GfxTexture {
        const hostAccessPass = device.createHostAccessPass();
        // console.log(`makeGfxTexture: size ${texture.width}x${texture.height}`);
        const gfxTexture = device.createTexture(makeTextureDescriptor2D(GfxFormat.U8_RGBA_NORM, texture.width, texture.height, 1));
        // console.log(gfxTexture);
        hostAccessPass.uploadTextureData(gfxTexture, 0, [texture.texels_rgba]);
        device.submitPass(hostAccessPass);
        return gfxTexture;
    }

    constructor(device: GfxDevice, gfxCache: GfxRenderCache, texture: Data.Texture) {
        this.texture = this.makeGfxTexture(device, texture);

        this.sampler = gfxCache.createSampler(device, {
            // wrapS: GfxWrapMode.CLAMP,
            // wrapT: GfxWrapMode.CLAMP,
            wrapS: GfxWrapMode.REPEAT,
            wrapT: GfxWrapMode.REPEAT,
            // minFilter: GfxTexFilterMode.POINT,
            // magFilter: GfxTexFilterMode.POINT,
            minFilter: GfxTexFilterMode.BILINEAR,
            magFilter: GfxTexFilterMode.BILINEAR,
            mipFilter: GfxMipFilterMode.NO_MIP,
            minLOD: 0, maxLOD: 0,
        });
    }
}

const textureMappingScratch = nArray(1, () => new TextureMapping());

export class SlyMeshRenderer {
    public modelMatrix = mat4.create();
    public textureMatrix = mat4.create();
    private textureMapping: (TextureMapping | null);
    private megaStateFlags: Partial<GfxMegaStateDescriptor> = {};

    constructor(textureData: (TextureData | null), public geometryData: GeometryData, public meshChunk: Data.MeshChunk) {
        if (textureData) {
            this.textureMapping = new TextureMapping();
            this.textureMapping.gfxTexture = textureData.texture;
            this.textureMapping.gfxSampler = textureData.sampler;
        } else {
            // this.textureMapping = textureMappingDummy;
        }

        this.megaStateFlags.frontFace = GfxFrontFaceMode.CW;
        // this.megaStateFlags.cullMode = GfxCullMode.BACK;
        this.megaStateFlags.cullMode = GfxCullMode.NONE;

        mat4.fromXRotation(this.modelMatrix, 3 * 90 * MathConstants.DEG_TO_RAD);
    }

    public prepareToRender(renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput) {
        const renderInst = renderInstManager.newRenderInst();
        renderInst.setInputLayoutAndState(this.geometryData.inputLayout, this.geometryData.inputState);
        if (this.textureMapping) {
            textureMappingScratch[0].copy(this.textureMapping);
            renderInst.setSamplerBindingsFromTextureMappings(textureMappingScratch);
        }
        renderInst.setMegaStateFlags(this.megaStateFlags);

        let offs = renderInst.allocateUniformBuffer(SlyProgram.ub_ShapeParams, 4*3);
        const d = renderInst.mapUniformBufferF32(SlyProgram.ub_ShapeParams);
        computeViewMatrix(modelViewScratch, viewerInput.camera);
        mat4.mul(modelViewScratch, modelViewScratch, this.modelMatrix);
        offs += fillMatrix4x3(d, offs, modelViewScratch);
        // offs += fillVec4v(d, offs, levelRenderData.lightDirection);
        // offs += fillVec4(d, offs, 1, 1, 0, 0);
        // offs += fillVec4(d, offs, 1, 1, 0, 0);
        // offs += fillVec4v(d, offs, levelRenderData.shadowTexScaleBias);
        // offs += fillVec4(d, offs, levelRenderData.baseDiffuse, levelRenderData.baseAmbient, 0, 0);

        renderInst.drawIndexes(this.geometryData.indexCount);
        renderInstManager.submitRenderInst(renderInst);
    }
}
