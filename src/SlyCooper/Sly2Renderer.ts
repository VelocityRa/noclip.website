import * as Viewer from '../viewer';
import * as UI from '../ui';
import { FakeTextureHolder } from '../TextureHolder';
import { GfxDevice, GfxRenderPass, GfxBindingLayoutDescriptor, GfxMegaStateDescriptor, GfxCullMode, GfxFrontFaceMode, GfxBlendMode, GfxBlendFactor, GfxSampler, GfxTexture, GfxWrapMode, GfxTexFilterMode, GfxMipFilterMode, GfxProgramDescriptorSimple, makeTextureDescriptor2D, GfxColor } from "../gfx/platform/GfxPlatform";
import { preprocessProgramObj_GLSL, DefineMap } from "../gfx/shaderc/GfxShaderCompiler";
import { pushAntialiasingPostProcessPass, opaqueBlackFullClearRenderPassDescriptor } from "../gfx/helpers/RenderGraphHelpers";
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper';
import { GfxRenderInstManager, GfxRendererLayer, makeSortKey, makeSortKeyOpaque } from "../gfx/render/GfxRenderInstManager";
import { fillVec2v, fillMatrix4x4, fillMatrix4x3, fillVec4, fillVec4v, fillColor } from "../gfx/helpers/UniformBufferHelpers";
import { mat4, vec3, vec2, vec4, quat } from "gl-matrix";
import { computeViewMatrix, CameraController, computeViewMatrixSkybox } from "../Camera";
import { nArray, assertExists, hexzero0x, hexzero, binzero, binzero0b } from "../util";
import { TextureMapping } from "../TextureHolder";
import { MathConstants, scaleMatrix, transformVec3Mat4w0 } from "../MathHelpers";
import { AABB } from "../Geometry";
import { setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers";
import { Texture } from "./SlyData";
import { DynamicObjectInstance, LevelObject, parseObjectEntries, TextureContainer, MeshContainer, MeshChunk, Mesh } from './Sly2Data';
import * as Settings from './SlyConstants';
import { drawWorldSpaceAABB, getDebugOverlayCanvas2D, drawWorldSpacePoint, drawWorldSpaceVector, drawWorldSpaceLine } from "../DebugJunk";
import { colorNewFromRGBA, Color, Magenta, colorToCSS, Red, Green, Blue, Cyan, colorFromHSL, OpaqueBlack } from "../Color";
import { GfxBuffer, GfxInputLayout, GfxInputState, GfxBufferUsage, GfxVertexAttributeDescriptor, GfxFormat, GfxInputLayoutBufferDescriptor, GfxVertexBufferFrequency } from "../gfx/platform/GfxPlatform";
import { makeStaticDataBuffer } from "../gfx/helpers/BufferHelpers";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache";
import { GfxrAttachmentSlot, makeBackbufferDescSimple } from '../gfx/render/GfxRenderGraph';
import { GrabListener } from '../GrabManager';
import { connectToSceneCollisionEnemyStrongLight } from '../SuperMarioGalaxy/ActorUtil';

class SlyRenderHacks {
    disableTextures = false;
    disableVertexColors = false;
    disableAmbientLighting = true;
    disableMeshInstances = false;
}

class SlyDebugHacks {
    drawMeshOrigins = false;
    drawSzmsPositions = false;
    drawSzmePositions = false;
}

let renderHacks = new SlyRenderHacks();
let debugHacks = new SlyDebugHacks();

class SlyProgram {
    public static ub_SceneParams = 0;
    public static ub_ShapeParams = 1;

    public both = `
layout(row_major, std140) uniform ub_SceneParams {
    Mat4x4 u_Projection;
    float u_Time;
};

layout(row_major, std140) uniform ub_ShapeParams {
    Mat4x4 u_BoneMatrix[1];
    // vec2 u_TexOffset;
};

// #define u_BaseDiffuse (u_Misc[0].x)
// #define u_BaseAmbient (u_Misc[0].y)

#define u_BaseDiffuse 1.0
#define u_BaseAmbient 0.2

uniform sampler2D u_Texture[1];

#define u_DiffuseTexture SAMPLER_2D(u_Texture[0])
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
    gl_Position = Mul(u_Projection, Mul(u_BoneMatrix[0], vec4(a_Position, 1.0)));
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
    // gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
    // return;

#if 1
    vec2 t_TexCoord = mod(v_TexCoord /* + u_TexOffset */, vec2(1.0));

#if ENABLE_TEXTURES
    vec4 t_DiffuseMapColor = texture(u_DiffuseTexture, t_TexCoord.xy);
    gl_FragColor.a = clamp(t_DiffuseMapColor.a * 2.0, 0.0, 1.0);
    // gl_FragColor.rgb = t_DiffuseMapColor.rgb;
    // return;
#else
    vec4 t_DiffuseMapColor = vec4(1.0);
    gl_FragColor.a = 1.0;
#endif

#if ENABLE_VERTEX_COLORS
    vec3 vertexColor = v_VertexColor;
#else
    vec3 vertexColor = vec3(1.0);
#endif

    float vertexLighting = 0.22;
    float tc1_w = 0.5;

    vec3 diffuseFinal = t_DiffuseMapColor.rgb * vertexColor * vertexLighting;

#if ENABLE_AMBIENT_LIGHTING
    vec3 lightDirection = normalize(vec3(0.1027, 0.02917, 0.267));
    vec3 lightColor = vec3(10./255., 23./255., 26./255.) * 0.5;
    float ambientLambert = clamp(max(dot(v_Normal.xyz, lightDirection), 0.0), 0.0, 1.0);
    vec3 ambientColor = lightColor * ambientLambert;

    vec3 ambientFinal = ambientColor;
    vec3 unkFinal = diffuseFinal / 2.0;
#else
    vec3 ambientFinal = vec3(0.0);
    vec3 unkFinal = diffuseFinal;
#endif

    // TODO: implement more properly
    // if (gl_FragColor.a == 0.0)
        // discard;

    gl_FragColor.rgb = (ambientFinal * tc1_w + unkFinal) * 4.0;

#endif
}
`;

    public defines: DefineMap = new Map<string, string>();

    constructor(renderHacks: SlyRenderHacks) {
        let boolToStr = (value: boolean) => {
            return value ? "0" : "1";
        };

        this.defines.set("ENABLE_TEXTURES", boolToStr(renderHacks.disableTextures));
        this.defines.set("ENABLE_VERTEX_COLORS", boolToStr(renderHacks.disableVertexColors));
        this.defines.set("ENABLE_AMBIENT_LIGHTING", boolToStr(renderHacks.disableAmbientLighting));
    }
}

const bindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 2, numSamplers: 1, },
];

interface Ray {
    pos: vec3;
    dir: vec3;
}
interface Line {
    posStart: vec3;
    posEnd: vec3;
}

function vec3Str(v: vec3) {
    return `\t${v[0].toFixed(3)}, ${v[1].toFixed(3)}, ${v[2].toFixed(3)}`;
}

function vec4Str(v: vec4) {
    return `\t${v[0].toFixed(3)}, ${v[1].toFixed(3)}, ${v[2].toFixed(3)}, ${v[3].toFixed(3)}`;
}

function mat4Str(m: mat4) {
    let str = "\t";
    for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
            str += `${m[x + y * 4].toFixed(3)} `;
        }
        str += '\n';
        if (y != 3)
            str += '\t'
    }
    return str;
}

interface Sphere {
    center: vec3;
    radius: number;
}

export class Sly2Renderer implements Viewer.SceneGfx {
    public textureHolder = new FakeTextureHolder([]);

    private program: (GfxProgramDescriptorSimple | null) = null;
    private renderHelper: GfxRenderHelper;
    private modelMatrix: mat4 = mat4.create();
    private meshRenderers: Sly2MeshRenderer[] = [];
    private meshRenderersReverse: Sly2MeshRenderer[] = [];


    public nonInteractiveListener: GrabListener = this;

    private viewerInput: Viewer.ViewerRenderInput;

    private debugRays: Ray[] = [];
    private debugLines: Line[] = [];

    private createShader(device: GfxDevice) {
        this.program = preprocessProgramObj_GLSL(device, new SlyProgram(renderHacks));
    }

    constructor(device: GfxDevice, objects: LevelObject[], dynObjectInsts: DynamicObjectInstance[], texIdToTex: Map<string, Texture>) {
        this.renderHelper = new GfxRenderHelper(device);

        const gfxCache = this.renderHelper.getCache();

        for (let object of objects) {
            // if (object.header.index != 286)
            // if (object.header.index != 269)
                // if (object.header.index < 50 || object.header.index > 100)
                // continue;

            for (let meshContainer of object.meshContainers) {
                for (let mesh of meshContainer.meshes) {
                    let meshInstanceMatrices = [mat4.create()];

                    for (let meshInstance of mesh.instances)
                        meshInstanceMatrices.push(mat4.clone(meshInstance));

                    // TODO: This is slow!
                    let dynObjects: mat4[] = [];
                    for (let dynObjInst of dynObjectInsts) {
                        if (object.header.id0 == dynObjInst.objId0) {
                            dynObjects.push(dynObjInst.matrix);
                        }
                    }
                    for (let dynObjInstance of dynObjects)
                        meshInstanceMatrices.push(mat4.clone(dynObjInstance));

                    if (mesh.u0 == 0) {
                        let transformC2 = meshContainer.meshC2Entries[mesh.containerInstanceMatrixIndex].transformMatrix;

                        if (transformC2) {
                            for (let i = 0; i < meshInstanceMatrices.length; ++i) {
                                mat4.multiply(meshInstanceMatrices[i], meshInstanceMatrices[i], transformC2!);
                            }
                        }
                    }

                    let chunkIdx = 0;
                    for (let meshChunk of mesh.chunks) {
                        // TODO(opt): don't make 2 separate Sly2MeshRenderers for this

                        for (let triIdx = 0; triIdx < 2; triIdx++) {
                            let triangleIndices = (triIdx == 0) ? meshChunk.trianglesIndices1 : meshChunk.trianglesIndices2;

                            const geometryData = new GeometryData(device, gfxCache, meshChunk, triangleIndices);

                            let isFullyOpaque = true;

                            let textureData: (TextureData | null)[] = nArray(2, () => null);
                            if (mesh.szme) {
                                let texId = (triIdx == 0) ? mesh.szme!.chunks[chunkIdx].textureId0 : mesh.szme!.chunks[chunkIdx].textureId1;
                                if (texId) {
                                    const textureDiffuse = texIdToTex.get(`${object.header.index}_${texId!}`);
                                    if (textureDiffuse) {
                                        textureData[0] = new TextureData(device, gfxCache, textureDiffuse)
                                        isFullyOpaque = textureDiffuse.isFullyOpaque;
                                    }
                                }
                            }

                            const meshRenderer = new Sly2MeshRenderer(textureData, geometryData, meshChunk, isFullyOpaque, meshInstanceMatrices);

                            this.meshRenderers.push(meshRenderer);
                        }
                        chunkIdx++;
                    }
                }
            }
            // this.meshRenderersReverse = this.meshRenderers.slice().reverse();
        }
    }

    public prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput, renderInstManager: GfxRenderInstManager) {
        const template = this.renderHelper.pushTemplateRenderInst();
        template.setBindingLayouts(bindingLayouts);

        if (!this.program)
            this.createShader(device);
        const gfxProgram = renderInstManager.gfxRenderCache.createProgramSimple(device, this.program!);
        template.setGfxProgram(gfxProgram);

        let offs = template.allocateUniformBuffer(SlyProgram.ub_SceneParams, 16 + 1);
        const d = template.mapUniformBufferF32(SlyProgram.ub_SceneParams);
        offs += fillMatrix4x4(d, offs, viewerInput.camera.projectionMatrix);
        d[offs++] = viewerInput.time / 10000.0;

        for (let meshRenderer of this.meshRenderers) {
            meshRenderer.prepareToRender(renderInstManager, viewerInput);
        }
        // for (let meshRenderer of this.meshRenderersReverse) {
        //     meshRenderer.prepareToRender(renderInstManager, viewerInput);
        // }

        renderInstManager.popTemplateRenderInst();

        this.renderHelper.prepareToRender(device);
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput) {
        this.viewerInput = viewerInput;
        const renderInstManager = this.renderHelper.renderInstManager;
        const builder = this.renderHelper.renderGraph.newGraphBuilder();

        const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, opaqueBlackFullClearRenderPassDescriptor);
        const mainDepthDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, viewerInput, opaqueBlackFullClearRenderPassDescriptor);

        const mainColorTargetID = builder.createRenderTargetID(mainColorDesc, 'Main Color');
        const mainDepthTargetID = builder.createRenderTargetID(mainDepthDesc, 'Main Depth');
        builder.pushPass((pass) => {
            pass.setDebugName('Main');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
            pass.exec((passRenderer) => {
                renderInstManager.drawOnPassRenderer(device, passRenderer);
            });
        });
        pushAntialiasingPostProcessPass(builder, this.renderHelper, viewerInput, mainColorTargetID);
        builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);

        this.prepareToRender(device, viewerInput, renderInstManager);
        this.renderHelper.renderGraph.execute(device, builder);
        renderInstManager.resetRenderInsts();

        // const ctx = getDebugOverlayCanvas2D();
        // drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, [0,0,0], Magenta, 5);

        if (debugHacks.drawMeshOrigins || debugHacks.drawSzmsPositions || debugHacks.drawSzmePositions) {
            const ctx = getDebugOverlayCanvas2D();

            for (let meshRenderer of this.meshRenderers) {
                if (debugHacks.drawSzmsPositions) {
                    let posVec = meshRenderer.meshChunk.positions;
                    for (let i = 0; i < posVec.length; i += 3) {
                        const p = vec3.fromValues(posVec[i + 0], posVec[i + 2], -posVec[i + 1]);
                        drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, p, Magenta, 5);
                    }
                }

                // if (meshRenderer.meshChunk.szme) {
                //     if (debugHacks.drawMeshOrigins) {
                //         let origin = meshRenderer.meshChunk.szme?.origin;
                //         let originVec = vec3.fromValues(origin[0], origin[2], -origin[1]);
                //         drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, originVec, Green, 9);
                //     }

                //     if (debugHacks.drawSzmePositions) {
                //         let posVec = meshRenderer.meshChunk.szme.positions;
                //         for (let i = 0; i < posVec.length; i += 3) {
                //             const p = vec3.fromValues(posVec[i + 0], posVec[i + 2], -posVec[i + 1]);
                //             drawWorldSpacePoint(ctx, window.main.viewer.viewerRenderInput.camera.clipFromWorldMatrix, p, Cyan, 7);

                //         }
                //     }
                // }
            }
        }

        // let aabb = new AABB(-1000, -5000, -1000, 100, 5000, 100);
        // const ctx = getDebugOverlayCanvas2D();
        // drawWorldSpaceAABB(ctx, viewerInput.camera.clipFromWorldMatrix, aabb);

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

        for (let debugRay of this.debugRays) {
            let randomColor = colorNewFromRGBA(0, 0, 0);
            const pseudoRandomFloat = (debugRay.pos[0] + debugRay.pos[1] + debugRay.pos[2] + debugRay.dir[0] + debugRay.dir[1] + debugRay.dir[2]) % 1;
            colorFromHSL(randomColor, pseudoRandomFloat, 0.5, 0.5, 1.0);
            drawWorldSpaceVector(getDebugOverlayCanvas2D(), viewerInput.camera.clipFromWorldMatrix, debugRay.pos, debugRay.dir, 1000, randomColor, 5);
        }

        for (let debugLine of this.debugLines) {
            drawWorldSpaceLine(getDebugOverlayCanvas2D(), viewerInput.camera.clipFromWorldMatrix, debugLine.posStart, debugLine.posEnd, Cyan);
        }
    }

    private setTexturesEnabled(enabled: boolean) {
        renderHacks.disableTextures = !enabled;
        this.program = null;
    }

    private setVertexColorsEnabled(enabled: boolean) {
        renderHacks.disableVertexColors = !enabled;
        this.program = null;
    }

    private setAmbientLightingEnabled(enabled: boolean) {
        renderHacks.disableAmbientLighting = !enabled;
        this.program = null;
    }

    private setMeshInstancesEnabled(enabled: boolean) {
        renderHacks.disableMeshInstances = !enabled;
        this.program = null;
    }

    public createPanels(): UI.Panel[] {
        const panels: UI.Panel[] = [];

        const renderHacksPanel = new UI.Panel();
        renderHacksPanel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;
        renderHacksPanel.setTitle(UI.RENDER_HACKS_ICON, 'Render Hacks');

        const enableVertexColorsCheckbox = new UI.Checkbox('Enable Vertex Colors', !renderHacks.disableVertexColors);
        enableVertexColorsCheckbox.onchanged = () => {
            this.setVertexColorsEnabled(enableVertexColorsCheckbox.checked);
        };
        renderHacksPanel.contents.appendChild(enableVertexColorsCheckbox.elem);

        const enableTextures = new UI.Checkbox('Enable Textures', !renderHacks.disableTextures);
        enableTextures.onchanged = () => {
            this.setTexturesEnabled(enableTextures.checked);
        };
        renderHacksPanel.contents.appendChild(enableTextures.elem);

        const enableAmbientLighting = new UI.Checkbox('Enable Ambient Lighting', !renderHacks.disableAmbientLighting);
        enableAmbientLighting.onchanged = () => {
            this.setAmbientLightingEnabled(enableAmbientLighting.checked);
        };
        renderHacksPanel.contents.appendChild(enableAmbientLighting.elem);

        const enableMeshInstances = new UI.Checkbox('Enable Mesh Instances', !renderHacks.disableMeshInstances);
        enableMeshInstances.onchanged = () => {
            this.setMeshInstancesEnabled(enableMeshInstances.checked);
        };
        renderHacksPanel.contents.appendChild(enableMeshInstances.elem);

        panels.push(renderHacksPanel);

        const debugPanel = new UI.Panel();
        debugPanel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;
        debugPanel.setTitle(UI.RENDER_HACKS_ICON, 'Debugging Hacks');
        const drawMeshOriginsCheckbox = new UI.Checkbox('Draw Mesh Origins', false);
        drawMeshOriginsCheckbox.onchanged = () => {
            debugHacks.drawMeshOrigins = drawMeshOriginsCheckbox.checked;
        };
        debugPanel.contents.appendChild(drawMeshOriginsCheckbox.elem);
        const drawSzmsPositionsCheckbox = new UI.Checkbox('Draw SZMS Positions', false);
        drawSzmsPositionsCheckbox.onchanged = () => {
            debugHacks.drawSzmsPositions = drawSzmsPositionsCheckbox.checked;
        };
        debugPanel.contents.appendChild(drawSzmsPositionsCheckbox.elem);
        const drawSzmePositionsCheckbox = new UI.Checkbox('Draw SZME Positions', false);
        drawSzmePositionsCheckbox.onchanged = () => {
            debugHacks.drawSzmePositions = drawSzmePositionsCheckbox.checked;
        };
        debugPanel.contents.appendChild(drawSzmePositionsCheckbox.elem);
        panels.push(debugPanel);

        // const layersPanel = new UI.LayerPanel();
        // layersPanel.setLayers(this.meshRenderers);
        // panels.push(layersPanel);

        return panels;
    }

    public destroy(device: GfxDevice): void {
        this.renderHelper.destroy(device);
    }

    //
    // GrabListener
    //
    public onGrab(e: MouseEvent): void {
        // Reference: https://antongerdelan.net/opengl/raycasting.html

        // Viewport (2D) -> NDC (3D)
        const mouseClipX = 2 * e.clientX * window.devicePixelRatio / this.viewerInput.backbufferWidth - 1;
        const mouseClipY = (2 * e.clientY * window.devicePixelRatio / this.viewerInput.backbufferHeight - 1) * -1;
        const rayNdc = vec3.fromValues(mouseClipX, mouseClipY, 1.0);

        // NDC (3D) -> Homogeneous clip (4D)
        // Negative Z to point forwards. W 1 for identity.
        const rayClip = vec4.fromValues(rayNdc[0], rayNdc[1], -1, 1);

        // Homogeneous clip (4D) -> Eye (4D)
        const projMatrix = this.viewerInput.camera.projectionMatrix;
        const invProjMatrix = mat4.invert(mat4.create(), projMatrix);
        let rayEye = vec4.transformMat4(vec4.create(), rayClip, invProjMatrix);
        // We only needed to un-project X and Y so let's set Z and W to mean "forwards, and not a point"
        rayEye = vec4.fromValues(rayEye[0], rayEye[1], -1, 0);

        // Eye (4D) -> World (4D)
        const viewMatrix = this.viewerInput.camera.viewMatrix;
        const invViewMatrix = mat4.invert(mat4.create(), viewMatrix);
        let rayWorldVec4 = vec4.transformMat4(vec4.create(), rayEye, invViewMatrix);
        let rayWorld = vec3.fromValues(rayWorldVec4[0], rayWorldVec4[1], rayWorldVec4[2]);
        vec3.normalize(rayWorld, rayWorld);

        const rayPos = mat4.getTranslation(vec3.create(), this.viewerInput.camera.worldMatrix);

        const ray = { pos: rayPos, dir: rayWorld };
        this.debugRays.push(ray);

        let hitSphere = (sphere: Sphere, ray: Ray) => {
            // Reference: https://www.scratchapixel.com/lessons/3d-basic-rendering/minimal-ray-tracer-rendering-simple-shapes/ray-sphere-intersection
            const l = vec3.subtract(vec3.create(), sphere.center, ray.pos);
            const tca = vec3.dot(l, ray.dir);

            const d2 = vec3.dot(l, l) - tca * tca;
            const radius2 = sphere.radius * sphere.radius;
            if (d2 > radius2)
                return false;

            const thc = Math.sqrt(radius2 - d2);
            let t0 = tca - thc;
            let t1 = tca + thc;

            if (t0 > t1)
                [t0, t1] = [t1, t0];

            if (t0 < 0) {
                t0 = t1; // if t0 is negative, let's use t1 instead
                if (t0 < 0)
                    return false; // both t0 and t1 are negative
            }

            return true;
        };

        // console.log(`ray: ${vec3Str(ray.pos)}  ${vec3Str(ray.dir)}`);
        for (let meshRenderer of this.meshRenderers) {
            for (let i = 0; i < meshRenderer.aabbSpheres.length; ++i) {
                const meshAABBSphere = meshRenderer.aabbSpheres[i];

                // console.log(` sphere r ${meshAABBSphere.radius}  ${vec3Str(meshAABBSphere.center)}`);
                if (hitSphere(meshAABBSphere, ray))
                    meshRenderer.aabbs[i].active = true;
            }
        }
    }
    public onMotion(dx: number, dy: number): void {
        // console.log(dx, dy);
    }
    public onGrabReleased(): void {
        // console.log('grab released');
    }
}

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

    constructor(device: GfxDevice, cache: GfxRenderCache, meshChunk: MeshChunk, triangleIndices: Uint16Array) {
        const indices = Uint16Array.from(triangleIndices);
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
        this.indexBuffer = makeStaticDataBuffer(device, GfxBufferUsage.INDEX, triangleIndices.buffer);

        const vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [
            { location: 0, bufferIndex: 0, format: GfxFormat.F32_RGB, bufferByteOffset: 0, }, // Position
            { location: 1, bufferIndex: 1, format: GfxFormat.F32_RGB, bufferByteOffset: 0, }, // Normal
            { location: 2, bufferIndex: 2, format: GfxFormat.F32_RG, bufferByteOffset: 0, }, // TexCoord
            { location: 3, bufferIndex: 3, format: GfxFormat.F32_RGBA, bufferByteOffset: 0, }, // VertexColor
        ];
        const vertexBufferDescriptors: GfxInputLayoutBufferDescriptor[] = [
            { byteStride: 3 * 0x04, frequency: GfxVertexBufferFrequency.PER_VERTEX, },
            { byteStride: 3 * 0x04, frequency: GfxVertexBufferFrequency.PER_VERTEX, },
            { byteStride: 2 * 0x04, frequency: GfxVertexBufferFrequency.PER_VERTEX, },
            { byteStride: 4 * 0x04, frequency: GfxVertexBufferFrequency.PER_VERTEX, },
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

    public isImageInline: boolean;

    private makeGfxTexture(device: GfxDevice, texture: Texture): GfxTexture {
        // console.log(`makeGfxTexture: size ${texture.width}x${texture.height}`);
        const gfxTexture = device.createTexture(makeTextureDescriptor2D(GfxFormat.U8_RGBA_NORM, texture.width, texture.height, 1));
        // console.log(gfxTexture);
        device.uploadTextureData(gfxTexture, 0, [texture.texelsRgba]);
        return gfxTexture;
    }

    private makeGfxSampler(device: GfxDevice, gfxCache: GfxRenderCache): GfxSampler {
        return gfxCache.createSampler(device, {
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

    constructor(device: GfxDevice, gfxCache: GfxRenderCache, texture: Texture) {
        this.texture = this.makeGfxTexture(device, texture);
        this.sampler = this.makeGfxSampler(device, gfxCache);
        this.isImageInline = texture.isImageInline;
    }
}

const textureMappingScratch = nArray(2, () => new TextureMapping());

const viewMatScratch = mat4.create();
const modelViewMatScratch = mat4.create();
const modelViewMatScratch2 = mat4.create();

const DRAW_ALL_AABBS = false;

const worldRotX = mat4.fromXRotation(mat4.create(), 3 * 90 * MathConstants.DEG_TO_RAD);

export class EditorAABB extends AABB {
    active = false;
}

// TODO add spheres to EditorAABB
// TODO

export class Sly2MeshRenderer {
    public textureMatrix = mat4.create();

    private textureMappingDiffuse0: (TextureMapping | null);
    // private textureMappingDiffuse1: (TextureMapping | null);

    private megaStateFlags: Partial<GfxMegaStateDescriptor> = {};
    private isSkybox: boolean = false;

    public name: string
    public visible: boolean = true;
    public setVisible(v: boolean): void {
        this.visible = v;
    }

    private instanceMatrices: mat4[] = [];

    public aabbs: EditorAABB[] = [];
    public aabbSpheres: Sphere[] = [];
    public aabbColor: Color;
    public aabbIsHuge = false;

    public drawAABB = false;

    constructor(
        textureData: (TextureData | null)[],
        public geometryData: GeometryData,
        public meshChunk: MeshChunk,
        private isFullyOpaque: boolean,
        meshInstanceMatrices: mat4[]) {

        this.name = meshChunk.name;

        if (textureData[0]) {
            this.textureMappingDiffuse0 = new TextureMapping();
            this.textureMappingDiffuse0.gfxTexture = textureData[0].texture;
            this.textureMappingDiffuse0.gfxSampler = textureData[0].sampler;
            this.isSkybox = textureData[0].isImageInline;
        }
        // if (textureData[1]) {
        //     this.textureMappingDiffuse1 = new TextureMapping();
        //     this.textureMappingDiffuse1.gfxTexture = textureData[1].texture;
        //     this.textureMappingDiffuse1.gfxSampler = textureData[1].sampler;
        // }

        this.megaStateFlags.frontFace = GfxFrontFaceMode.CW;
        // this.megaStateFlags.cullMode = GfxCullMode.BACK;
        this.megaStateFlags.cullMode = GfxCullMode.NONE;

        setAttachmentStateSimple(this.megaStateFlags, {
            blendMode: GfxBlendMode.ADD,
            blendSrcFactor: GfxBlendFactor.SRC_ALPHA,
            blendDstFactor: GfxBlendFactor.ONE_MINUS_SRC_ALPHA,
        });

        for (let meshInstanceMatrix of meshInstanceMatrices)
            this.instanceMatrices.push(meshInstanceMatrix)

        for (let meshInstanceMatrix of meshInstanceMatrices) {
            let aabb = new EditorAABB();
            aabb.setFromPointsFloatArray(meshChunk.positions);
            mat4.copy(modelViewMatScratch2, worldRotX);
            mat4.mul(modelViewMatScratch2, modelViewMatScratch2, meshInstanceMatrix);
            aabb.transform(aabb, modelViewMatScratch2);
            this.aabbs.push(aabb);

            let center = vec3.create();
            aabb.centerPoint(center);
            let radius = aabb.boundingSphereRadius();
            this.aabbSpheres.push({ center, radius });
        }

        const firstExtent = this.aabbs[0].extents(vec3.create());
        const pseudoRandomFloat = (vec3.length(firstExtent)) % 1;
        let randomColor = colorFromHSL(colorNewFromRGBA(0, 0, 0), pseudoRandomFloat, 0.5, 0.5, 0.3);
        this.aabbColor = randomColor;

        this.aabbIsHuge = vec3.length(firstExtent) > 10000;
    }

    public prepareToRender(renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput) {
        if (!this.visible)
            return;

        const template = renderInstManager.pushTemplateRenderInst();

        template.setInputLayoutAndState(this.geometryData.inputLayout, this.geometryData.inputState);
        if (this.textureMappingDiffuse0) {
            // todo: is scratch/copy necessary? ask jasper
            textureMappingScratch[0].copy(this.textureMappingDiffuse0);
            template.setSamplerBindingsFromTextureMappings(textureMappingScratch);
        }
        template.setMegaStateFlags(this.megaStateFlags);

        let rendererLayer: GfxRendererLayer;
        if (this.isSkybox)
            rendererLayer = GfxRendererLayer.BACKGROUND;
        else if (this.isFullyOpaque)
            rendererLayer = GfxRendererLayer.OPAQUE;
        else
            rendererLayer = GfxRendererLayer.TRANSLUCENT;

        template.sortKey = makeSortKey(rendererLayer);

        if (this.isSkybox)
            computeViewMatrixSkybox(viewMatScratch, viewerInput.camera);
        else
            computeViewMatrix(viewMatScratch, viewerInput.camera);

        // let texOffset = vec2.create();

        // if (!this.isSkybox)
        //     texOffset[1] = viewerInput.time / 10000.0;

        // TODO: instanced rendering

        for (let instanceMatrix of this.instanceMatrices) {
            const renderInstInstance = renderInstManager.newRenderInst();

            let offs = renderInstInstance.allocateUniformBuffer(SlyProgram.ub_ShapeParams, 4 * 4 /* + 2*/);
            const d = renderInstInstance.mapUniformBufferF32(SlyProgram.ub_ShapeParams);

            mat4.copy(modelViewMatScratch, viewMatScratch);

            mat4.mul(modelViewMatScratch, modelViewMatScratch, worldRotX);
            mat4.mul(modelViewMatScratch, modelViewMatScratch, instanceMatrix);

            if (this.isSkybox)
                mat4.scale(modelViewMatScratch, modelViewMatScratch, [2, 2, 2]);

            offs += fillMatrix4x4(d, offs, modelViewMatScratch);
            // offs += fillVec2v(d, offs, texOffset);

            renderInstInstance.drawIndexes(this.geometryData.indexCount);
            renderInstManager.submitRenderInst(renderInstInstance);

            if (renderHacks.disableMeshInstances)
                break;
        }

        if (!this.isSkybox && !this.aabbIsHuge) {
            for (let aabb of this.aabbs)
                if (DRAW_ALL_AABBS || aabb.active)
                    drawWorldSpaceAABB(getDebugOverlayCanvas2D(), viewerInput.camera.clipFromWorldMatrix, aabb, mat4.create(), this.aabbColor);
        }

        renderInstManager.popTemplateRenderInst();
    }
}
