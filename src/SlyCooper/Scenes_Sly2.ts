import ArrayBufferSlice from '../ArrayBufferSlice';
import { mat4, vec2, vec3, quat } from 'gl-matrix';
import { SceneGroup, SceneDesc, SceneGfx, ViewerRenderInput } from "../viewer";
import * as Viewer from "../viewer";
import { GfxDevice } from "../gfx/platform/GfxPlatform";
import { SceneContext } from "../SceneBase";
import { IS_DEVELOPMENT } from "../BuildVersion";
import { assert, hexzero, hexzero0x, leftPad, spacePad } from '../util';
import { NamedArrayBufferSlice } from "../DataFetcher";
import { downloadCanvasAsPng, downloadText } from "../DownloadUtils";
import { range, range_end, transformVec3Mat4w1 } from '../MathHelpers';
import { downloadBuffer } from '../DownloadUtils';
import { makeZipFile, ZipFileEntry } from '../ZipFile';
import { Sly2Renderer } from './Sly2Renderer';
import { DataStream } from "./DataStream";
import { sprintf } from "./sprintf";
import { Texture } from './SlyData';
import { DynamicObjectInstance, LevelObject, parseObjectEntries, TextureContainer, MeshContainer } from './Sly2Data';
import { Accessor, Document, WebIO, Node as GLTFNode, Mesh as GLTFMesh, Material as GLTFMaterial } from '@gltf-transform/core';


const pathBase = `Sly2`;

let enc = new TextEncoder();

// Research at: https://github.com/VelocityRa/SlyTools/blob/main/templates/sly2_ps3_level.bt


// function parseObject(stream: DataStream, scriptOffsets: (number[] | null)): Object {
// }

// TODO: instances for other objects

// TODO: move elsewhere
export const SCRIPTS_EXPORT = false;
export const TEXTURES_EXPORT = false;

export const MESH_EXPORT = false;
export const MESH_EXPORT_MATERIALS = false;

export const MESH_EXPORT_GLTF_OLD = false;
export const MESH_EXPORT_GLTF = false;
export const MESH_EXPORT_GLTF_MATERIALS = false;

export const MESH_SEPARATE_TO_OBJECTS = true;
export const MESH_SEPARATE_ONLY_OBJECTS = false;
export const MESH_SEPARATE_OBJECT_CHUNKS = false;
export const MESH_SCALE = 1 / 100.0;

export const LOG_OFFSETS_FOR_010_EDITOR = true;

class Sly2LevelSceneDesc implements SceneDesc {
    private objectOffsets: number[];
    private textureDescOffsets: number[];
    private scriptOffsets: number[];
    private meshcontOffsets: number[];
    private dynObjInstOffsets: number[];

    constructor(
        public id: string,
        public name: string) {
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<SceneGfx> {
        const offsetsBin = await context.dataFetcher.fetchData(`${pathBase}/sly2-${this.id}-offsets.bin`)
        let offsetsStream = new DataStream(offsetsBin);

        let deserializeArray = (s: DataStream): number[] => {
            let len = s.u32();
            let arr: number[] = [];
            for (let i = 0; i < len; ++i)
                arr.push(s.u32());
            return arr;
        };
        this.objectOffsets = deserializeArray(offsetsStream);
        this.textureDescOffsets = deserializeArray(offsetsStream);
        this.scriptOffsets = deserializeArray(offsetsStream);
        this.meshcontOffsets = deserializeArray(offsetsStream);
        this.dynObjInstOffsets = deserializeArray(offsetsStream);

        let logArrayHex = (arr: number[], name: string = "") => {
            let msg = "";
            if (LOG_OFFSETS_FOR_010_EDITOR) {
                msg = `local int ${name}[${arr.length}] = {`;
                for (let v of arr) {
                    msg += `${hexzero0x(v, 4)},`;
                }
                msg = msg.slice(0, -1);
                msg += '};';
            } else {
                msg = `${name}: `;
                for (let v of arr) {
                    msg += `${hexzero(v, 8)} `;
                }
            }
            console.log(msg);
        };

        // logArrayHex(this.objectOffsets, "objectOffsets");
        // logArrayHex(this.textureDescOffsets, "textureDescOffsets");
        // logArrayHex(this.scriptOffsets, "scriptOffsets");
        // logArrayHex(this.meshcontOffsets, "meshcontOffsets");
        // logArrayHex(this.dynObjInstOffsets, "dynObjInstOffsets");

        // TODO? Use compressed original files (orig. or zip/etc), or decompressed trimmed files

        const bin = await context.dataFetcher.fetchData(`${pathBase}/${this.id}.slyZ.dec`)
        let s = new DataStream(bin);

        console.log(`loaded ${pathBase}/${this.id} of size ${bin.byteLength}`);

        const objectEntries = parseObjectEntries(s);
        console.log(objectEntries);

        // TODO: refactor to func

        let scriptFileEntries: ZipFileEntry[] = [];

        let scriptIndex = 0;
        let textureIndex = 0;
        let meshContIndex = 0;

        let objects: LevelObject[] = [];

        for (let i = 0; i < objectEntries.length; ++i) {
            let objectEntry = objectEntries[i];
            let objectOffset = this.objectOffsets[i];

            s.offs = objectOffset;

            let textureSize = s.u32();
            s.skip(4);
            let hasScripts = (s.u32() != 0);

            if (SCRIPTS_EXPORT && hasScripts) {
                while (scriptIndex < this.scriptOffsets.length) {
                    let scriptOffset = this.scriptOffsets[scriptIndex];

                    if (i >= objectEntries.length || scriptOffset > this.objectOffsets[i + 1])
                        break;

                    s.offs = scriptOffset;
                    let str0 = s.readString(s.u16());
                    let str1 = s.readString(s.u16());
                    let str2 = s.readString(s.u16());

                    if (str1 !== "")
                        console.info(`non0 str1: ${str1}`);

                    let filename = `${objectEntry.name}/${str0.replace(/\|/g, ",")}.scm`;
                    let data = new ArrayBufferSlice(enc.encode(str2).buffer);

                    scriptFileEntries.push({ filename, data });

                    ++scriptIndex;
                }
            }

            let object = new LevelObject();
            object.header = objectEntry;
            object.offset = objectOffset;

            let objLog = `${leftPad(objectEntry.name, 32, ' ')} #${leftPad(`${objectEntry.count}`, 2)} | TEX `;
            let hasTex = false;
            while (textureIndex < this.textureDescOffsets.length) {
                let textureDescOffset = this.textureDescOffsets[textureIndex];

                if (i >= objectEntries.length || textureDescOffset > this.objectOffsets[i + 1])
                    break;

                s.offs = textureDescOffset;
                object.textureContainer = new TextureContainer(s, textureSize);

                objLog += `${hexzero(textureDescOffset)}, `
                hasTex = true;

                ++textureIndex;
            }
            if (hasTex)
                objLog = objLog.substring(0, objLog.length - 2);

            objLog += ` | MESH `;
            let hasMeshcont = false;
            while (meshContIndex < this.meshcontOffsets.length) {
                let meshcontOffset = this.meshcontOffsets[meshContIndex];

                if (i >= objectEntries.length || meshcontOffset > this.objectOffsets[i + 1])
                    break;

                s.offs = meshcontOffset;
                try {
                    let meshContainer = new MeshContainer(s, meshContIndex)
                    object.meshContainers.push(meshContainer);
                    objLog += `[`;
                    for (let mesh of meshContainer.meshes)
                        objLog += `${mesh.type},`;
                    if (meshContainer.meshes.length > 0)
                        objLog = objLog.substring(0, objLog.length - 1);
                    objLog += `]${hexzero(meshcontOffset)}, `
                } catch (error) {
                    console.error(`obj \'${objectEntry.name}\' mcont @ ${hexzero0x(meshcontOffset)} id ${meshContIndex}: ${error}`);
                }

                hasMeshcont = true;

                ++meshContIndex;
            }
            if (hasMeshcont)
                objLog = objLog.substring(0, objLog.length - 2);

            console.log(objLog);

            objects.push(object);
        }

        let dynObjectInsts: DynamicObjectInstance[] = [];

        for (let dynObjOffs of this.dynObjInstOffsets) {
            s.offs = dynObjOffs;

            let dynObj = new DynamicObjectInstance(s);
            dynObjectInsts.push(dynObj);
        }

        if (SCRIPTS_EXPORT) {
            const zipFile = makeZipFile(scriptFileEntries);
            downloadBuffer(`${this.id}_scripts.zip`, zipFile);
        }

        for (let object of objects) {
            let texEntryIdx = 0;
            const texCont = object.textureContainer;
            let descIdx = 0;
            for (let desc of texCont.textureDescs) {
                for (let indices of desc.indices) {
                    enum TextureType {
                        Diffuse,
                        Unk
                    }

                    let makeTexture = (clutIndexIndex: number, imageIndexIndex: number, type: TextureType) => {
                        const clutIndex = indices.clutIndices[clutIndexIndex];
                        const imageIndex = indices.imageIndices[imageIndexIndex];

                        if (clutIndex >= texCont.cluts.length) {
                            console.warn(`warn: [id ${texEntryIdx}] clutIndex (${clutIndex}) out of bounds, skipping`);
                            return;
                        }
                        if (imageIndex >= texCont.images.length) {
                            console.warn(`warn: [id ${texEntryIdx}] imageIndex (${imageIndex}) out of bounds, skipping`);
                            return;
                        }
                        const clutMeta = texCont.cluts[clutIndex];
                        const imageMeta = texCont.images[imageIndex];

                        const width = imageMeta.width;
                        const height = imageMeta.height;
                        // console.log(`clutMeta: ${clutMeta.offset} imageMeta: ${imageMeta.offset}`);
                        // console.log(`w: ${width} h: ${height} C: ${hexzero(clutMeta.offset, 8)} I: ${hexzero(imageMeta.offset, 8)}`);

                        let typeStr = '';
                        switch (type) {
                            case TextureType.Diffuse: typeStr = 'Dif'; break;
                            case TextureType.Unk: typeStr = 'Unk'; break;
                        }

                        const name = sprintf(`%d_%s %03d-%02d-%02d-%02d %03d-%03d Res %04dx%04d Clt %05X Img %06X Cols %03d T %s`,
                            object.header.index, object.header.name, texEntryIdx, descIdx, clutIndexIndex, imageIndexIndex, clutIndex, imageIndex, width, height,
                            clutMeta.dataOffset, imageMeta.dataOffset, clutMeta.entryCount, typeStr);
                        console.info(name);
                        // console.log(`pal ${hexzero(clutMeta.data.byteLength)} ${hexzero(clutMeta.dataOffset)} img ${hexzero(imageMeta.data.byteLength)} ${hexzero(imageMeta.dataOffset)}`);

                        const paletteBuf = clutMeta.data;
                        const imageBuf = imageMeta.data;

                        const isImageInline = imageMeta.isInline();

                        const texture = new Texture(texEntryIdx, paletteBuf, imageBuf, width, height, clutMeta.entryCount, clutMeta.formatSize, name, isImageInline);
                        switch (type) {
                            case TextureType.Diffuse:
                                object.texturesDiffuse.push(texture);
                                break;
                            case TextureType.Unk:
                                object.texturesUnk.push(texture);
                                break;
                        }
                    };

                    const clutCount = indices.clutIndices.length;
                    const imageCount = indices.imageIndices.length;

                    const isNImgNPal = (clutCount == imageCount);
                    const is1Img1Pal = (clutCount == 1 && imageCount == 1);
                    const is1ImgNPal = (imageCount == 1 && clutCount > 1);
                    const isNImgMPal = (!isNImgNPal && clutCount > 1 && imageCount > 1);
                    const isPalDoubleImg = (clutCount == imageCount * 2);
                    const isPalTripleImg = (clutCount == imageCount * 3);

                    if (is1Img1Pal) {
                        console.log(`1ImgMPal: ${texEntryIdx} ${clutCount} ${imageCount}`);
                        makeTexture(0, 0, TextureType.Diffuse);
                    } else if (is1ImgNPal) {
                        console.log(`1ImgMPal: ${texEntryIdx} ${clutCount} ${imageCount}`);
                        for (let clutIndexIndex = 0; clutIndexIndex < indices.clutIndices.length; ++clutIndexIndex) {
                            const type = clutIndexIndex == 0 ? TextureType.Diffuse : TextureType.Unk;
                            makeTexture(clutIndexIndex, 0, type);
                        }
                    } else if (isNImgMPal) {
                        console.error(`NImgMPal: ${texEntryIdx} ${clutCount} ${imageCount}`);
                        if (!Number.isInteger(clutCount / imageCount)) {
                            console.warn(`NImgMPal: nonint ${texEntryIdx} ${clutCount} ${imageCount}`);
                            makeTexture(0, 0, TextureType.Diffuse);
                            continue;
                        }
                        const ratio = clutCount / imageCount;
                        for (let i = 0; i < clutCount; ++i) {
                            const type = i == 0 ? TextureType.Diffuse : TextureType.Unk;
                            makeTexture(i, Math.floor(i / ratio), type);
                        }
                    }

                    descIdx++;
                }
                texEntryIdx++;
            }
        }

        if (TEXTURES_EXPORT) {
            let zipFileEntries: ZipFileEntry[] = [];

            const dumpTextures = async (textures: (Texture | null)[]) => {
                await Promise.all(textures.filter((texture) => texture !== null).map(async (texture) => {
                    const surface = texture!.toCanvas().surfaces[0];
                    const blob: (Blob | null) = await new Promise((resolve, reject) => {
                        surface.toBlob((blob: Blob | null) => blob !== null ? resolve(blob) : reject(null));
                    });
                    if (blob) {
                        const data = await blob.arrayBuffer();
                        zipFileEntries.push({ filename: texture!.name + '.png', data: new ArrayBufferSlice(data) });
                    }
                }));
            };

            for (let object of objects) {
                await dumpTextures(object.texturesDiffuse);
                await dumpTextures(object.texturesUnk);
            }

            console.log(zipFileEntries);

            const zipFile = makeZipFile(zipFileEntries);
            downloadBuffer(`${this.id}_textures.zip`, zipFile);
        }

        if (MESH_EXPORT) {
            let obj_str = "";
            obj_str += `mtllib ${this.id}.mtl\n`;

            obj_str += `g all\n`;
            obj_str += `s off\n`;

            let face_idx_base = 1;

            let chunkTotalIdx = 0;
            for (let object of objects) {
                if (MESH_SEPARATE_TO_OBJECTS && MESH_SEPARATE_ONLY_OBJECTS)
                    obj_str += `o [${object.header.index}]${object.header.name}\n`;

                // if (object.header.index != 280)
                //     continue;

                for (let meshContainer of object.meshContainers) {
                    let meshIdx = 0;

                    for (let mesh of meshContainer.meshes) {
                        if (MESH_SEPARATE_TO_OBJECTS && !MESH_SEPARATE_ONLY_OBJECTS && !MESH_SEPARATE_OBJECT_CHUNKS)
                            obj_str += `o ${mesh.container.containerIndex}_[${object.header.index}]${object.header.name}_${mesh.meshIndex}_${chunkTotalIdx}_T${mesh.type}_${hexzero(mesh.offset)}\n`;

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

                        let instanceIdx = 0;
                        for (let meshInstanceMatrix of meshInstanceMatrices) {
                            let chunkIdx = 0;
                            for (let chunk of mesh.chunks) {
                                if (MESH_SEPARATE_TO_OBJECTS && !MESH_SEPARATE_ONLY_OBJECTS && MESH_SEPARATE_OBJECT_CHUNKS)
                                    obj_str += `o ${mesh.container.containerIndex}_[${object.header.index}]${object.header.name}_${mesh.meshIndex}_${chunkIdx}_${instanceIdx}_${chunkTotalIdx}_${hexzero(mesh.offset)}\n`;

                                let newPos = vec3.create();

                                for (let i = 0; i < chunk.positions.length; i += 3) {
                                    const pos = vec3.fromValues(chunk.positions[i + 0], chunk.positions[i + 1], chunk.positions[i + 2]);

                                    vec3.transformMat4(newPos, pos, meshInstanceMatrix);

                                    let scaledPos = vec3.fromValues(
                                        newPos[0] * MESH_SCALE,
                                        newPos[1] * MESH_SCALE,
                                        newPos[2] * MESH_SCALE);

                                    obj_str += `v ${scaledPos[0]} ${scaledPos[1]} ${scaledPos[2]}\n`;
                                }

                                for (let i = 0; i < chunk.normals.length; i += 3) {
                                    let normal = vec3.fromValues(chunk.normals[i], chunk.normals[i + 1], chunk.normals[i + 2]);

                                    obj_str += `vn ${normal[0]} ${normal[1]} ${normal[2]}\n`;
                                }

                                for (let i = 0; i < chunk.texCoords.length; i += 2) {
                                    const texCoord = vec2.fromValues(chunk.texCoords[i], chunk.texCoords[i + 1]);

                                    obj_str += `vt ${texCoord[0]} ${texCoord[1]}\n`;
                                }
                                const szme = mesh.szme.chunks[chunkIdx];

                                if (MESH_EXPORT_MATERIALS) {
                                    obj_str += `usemtl ${object.header.index}_${szme!.textureId0}\n`
                                }

                                for (let i = 0; i < chunk.trianglesIndices1.length; i += 3) {
                                    const f0 = face_idx_base + chunk.trianglesIndices1[i + 0];
                                    const f1 = face_idx_base + chunk.trianglesIndices1[i + 1];
                                    const f2 = face_idx_base + chunk.trianglesIndices1[i + 2];

                                    obj_str += `f ${f0}/${f0}/${f0} ${f1}/${f1}/${f1} ${f2}/${f2}/${f2}\n`;
                                }

                                if (MESH_EXPORT_MATERIALS) {
                                    obj_str += `usemtl ${object.header.index}_${szme!.textureId1}\n`
                                }

                                for (let i = 0; i < chunk.trianglesIndices2.length; i += 3) {
                                    const f0 = face_idx_base + chunk.trianglesIndices2[i + 0];
                                    const f1 = face_idx_base + chunk.trianglesIndices2[i + 1];
                                    const f2 = face_idx_base + chunk.trianglesIndices2[i + 2];

                                    obj_str += `f ${f0}/${f0}/${f0} ${f1}/${f1}/${f1} ${f2}/${f2}/${f2}\n`;
                                }
                                face_idx_base += chunk.positions.length / 3;

                                chunkIdx++;
                                chunkTotalIdx++;
                            }
                            instanceIdx++;
                        }
                        meshIdx++;
                    }
                }
            }

            downloadText(`${this.id}.obj`, obj_str);

            if (MESH_EXPORT_MATERIALS) {
                let mat_str = 'newmtl empty\n';

                for (let object of objects) {
                    for (let texture of object.texturesDiffuse) {
                        mat_str += `newmtl ${object.header.index}_${texture.texEntryIdx}\n`;

                        const texFilename = `${this.id}_textures/${texture.name}.png`;
                        mat_str += `map_Kd ${texFilename}\n`;
                        if (!texture.isFullyOpaque)
                            mat_str += `map_d ${texFilename}\n`;
                    }
                }

                downloadText(`${this.id}.mtl`, mat_str);
            }
        }


        if (MESH_EXPORT_GLTF) {
            const io = new WebIO({ credentials: 'include' });

            let doc = new Document();
            let rootMatrix = mat4.create();
            mat4.fromRotationTranslationScale(rootMatrix,
                quat.fromEuler(quat.create(), -90, 0, 0), [0, 0, 0], [MESH_SCALE, MESH_SCALE, MESH_SCALE]);
            let mainScene = doc.createScene(`${this.id}`);

            let texIdToMaterialMap = new Map<string, GLTFMaterial>();

            const addTexturesAndMaterials = async (object: LevelObject, textures: (Texture | null)[]) => {
                await Promise.all(textures.filter((texture) => texture !== null).map(async (texture) => {
                    const surface = texture!.toCanvas().surfaces[0];
                    const blob: (Blob | null) = await new Promise((resolve, reject) => {
                        surface.toBlob((blob: Blob | null) => blob !== null ? resolve(blob) : reject(null));
                    });
                    if (blob) {
                        const data = await blob.arrayBuffer();
                        // zipFileEntries.push({ filename: texture!.name + '.png', data: new ArrayBufferSlice(data) });

                        let baseColTex = doc.createTexture(`${texture!.name}`)
                            .setMimeType('image/png')
                            .setImage(data);
                        let material = doc.createMaterial(`${object.header.index}_${object.header.name}_${texture!.name}`)
                            .setBaseColorTexture(baseColTex);

                        texIdToMaterialMap.set(`${object.header.index}_${texture!.texEntryIdx}`, material);
                    }
                }));
            };

            if (MESH_EXPORT_GLTF_MATERIALS) {
                for (let object of objects) {
                    await addTexturesAndMaterials(object, object.texturesDiffuse);
                    // await addTexturesAndMaterials(object, object.texturesUnk);
                }
            }

            const getTRS = (m: mat4) => {
                return { t: mat4.getTranslation(vec3.create(), m), r: mat4.getRotation(quat.create(), m), s: mat4.getScaling(vec3.create(), m) };
            };

            const setNodeMatrix = (node: GLTFNode, mat: mat4) => {
                let trs = getTRS(mat);
                node.setTranslation([trs.t[0], trs.t[1], trs.t[2]]);
                quat.normalize(trs.r, trs.r);
                node.setRotation([trs.r[0], trs.r[1], trs.r[2], trs.r[3]]);
                node.setScale([trs.s[0], trs.s[1], trs.s[2]]);
            }

            const globalBuffer = doc.createBuffer();

            let chunkTotalIdx = 0;

            for (let object of objects) {
                // let objNode = doc.createNode(`obj: [${object.header.index}] ${object.header.name}`);
                // setNodeMatrix(objNode, dynInstMat);
                // rootNode.addChild(objNode);

                // if (object.header.index != 280)
                //     continue;

                for (let meshContainer of object.meshContainers) {
                    let meshIdx = 0;

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

                        let instanceIdx = 0;
                        for (let meshInstMatrix of meshInstanceMatrices) {
                            let chunkIdx = 0;
                            for (let chunk of mesh.chunks) {
                                // let meshInstChunkNode = doc.createNode(`meshInstChunk: ${instanceIdx}`);
                                // meshInstNode.addChild(meshInstChunkNode);

                                if (!chunk.gltfMesh &&
                                    chunk.positions.length && chunk.normals.length && chunk.texCoords.length &&
                                    (chunk.trianglesIndices1.length || chunk.trianglesIndices2.length)) {
                                    // todo: redundant creates ?

                                    const szme = mesh.szme.chunks[chunkIdx];

                                    const position = doc.createAccessor()
                                        .setType(Accessor.Type.VEC3)
                                        .setArray(chunk.positions)
                                        .setBuffer(globalBuffer);
                                    const normal = doc.createAccessor()
                                        .setType(Accessor.Type.VEC3)
                                        .setArray(chunk.normals)
                                        .setBuffer(globalBuffer);
                                    const texcoord = doc.createAccessor()
                                        .setType(Accessor.Type.VEC2)
                                        .setArray(chunk.texCoords)
                                        .setBuffer(globalBuffer);

                                    const prim = doc.createPrimitive()
                                        .setAttribute('POSITION', position)
                                        .setAttribute('NORMAL', normal)
                                        .setAttribute('TEXCOORD_0', texcoord);

                                    let meshGltf = doc.createMesh();

                                    if (chunk.trianglesIndices1.length) {
                                        const indices1 = doc.createAccessor()
                                            .setType(Accessor.Type.SCALAR)
                                            .setArray(chunk.trianglesIndices1)
                                            .setBuffer(globalBuffer);
                                        const mat1 = !MESH_EXPORT_GLTF_MATERIALS ? null :
                                            texIdToMaterialMap.get(`${object.header.index}_${szme!.textureId0}`) || null;
                                        const prim1 = prim.clone()
                                            .setMaterial(mat1)
                                            .setIndices(indices1);
                                        meshGltf.addPrimitive(prim1);
                                    }
                                    if (chunk.trianglesIndices2.length) {
                                        const indices2 = doc.createAccessor()
                                            .setType(Accessor.Type.SCALAR)
                                            .setArray(chunk.trianglesIndices2)
                                            .setBuffer(globalBuffer);
                                        const mat2 = !MESH_EXPORT_GLTF_MATERIALS ? null :
                                            texIdToMaterialMap.get(`${object.header.index}_${szme!.textureId1}`) || null;
                                        const prim2 = prim.clone()
                                            .setMaterial(mat2)
                                            .setIndices(indices2);
                                        meshGltf.addPrimitive(prim2);
                                    }

                                    chunk.gltfMesh = meshGltf;
                                }

                                let meshInstNode = doc.createNode()
                                    .setName(`${mesh.container.containerIndex}_[${object.header.index}]${object.header.name}_${mesh.meshIndex}_${chunkIdx}_${instanceIdx}_${chunkTotalIdx}_${hexzero(mesh.offset)}`);
                                meshInstNode.setMesh(chunk.gltfMesh);

                                let meshInstMatrixFinal = mat4.multiply(mat4.create(), rootMatrix, meshInstMatrix);
                                setNodeMatrix(meshInstNode, meshInstMatrixFinal);
                                mainScene.addChild(meshInstNode);

                                chunkIdx++;
                                chunkTotalIdx++;
                            }
                            instanceIdx++;
                        }
                        meshIdx++;
                    }
                }
            }

            const glb = io.writeBinary(doc);
            downloadBuffer(`${this.id}.glb`, glb);
        }

        // testing
        if (MESH_EXPORT_GLTF_OLD) {
            const io = new WebIO({ credentials: 'include' });

            let doc = new Document();
            let rootMatrix = mat4.create();
            let r = quat.create();
            mat4.fromRotationTranslationScale(rootMatrix,
                quat.fromEuler(r, -90, 0, 0), [0, 0, 0], [MESH_SCALE, MESH_SCALE, MESH_SCALE]);
            let mainScene = doc.createScene(`${this.id}`);

            let texIdToMaterialMap = new Map<string, GLTFMaterial>();

            const addTexturesAndMaterials = async (object: LevelObject, textures: (Texture | null)[]) => {
                await Promise.all(textures.filter((texture) => texture !== null).map(async (texture) => {
                    const surface = texture!.toCanvas().surfaces[0];
                    const blob: (Blob | null) = await new Promise((resolve, reject) => {
                        surface.toBlob((blob: Blob | null) => blob !== null ? resolve(blob) : reject(null));
                    });
                    if (blob) {
                        const data = await blob.arrayBuffer();
                        // zipFileEntries.push({ filename: texture!.name + '.png', data: new ArrayBufferSlice(data) });

                        let baseColTex = doc.createTexture(`${texture!.name}`)
                            .setMimeType('image/png')
                            .setImage(data);
                        let material = doc.createMaterial(`${object.header.index}_${object.header.name}_${texture!.name}`)
                            .setBaseColorTexture(baseColTex);

                        texIdToMaterialMap.set(`${object.header.index}_${texture!.texEntryIdx}`, material);
                    }
                }));
            };

            if (MESH_EXPORT_GLTF_MATERIALS) {
                for (let object of objects) {
                    await addTexturesAndMaterials(object, object.texturesDiffuse);
                    // await addTexturesAndMaterials(object, object.texturesUnk);
                }
            }

            const objIdxToObjDynInstMatsMap = new Map<number, mat4[]>();
            for (const dynObjInst of dynObjectInsts) {
                for (const object of objects) {
                    if (object.header.id0 == dynObjInst.objId0) {
                        const matArray = objIdxToObjDynInstMatsMap.get(object.header.index);

                        if (matArray) {
                            matArray.push(dynObjInst.matrix);
                        } else {
                            objIdxToObjDynInstMatsMap.set(object.header.index, [dynObjInst.matrix]);
                        }

                        break;
                    }
                }
            }

            const getTRS = (m: mat4) => {
                let t = vec3.create(); let r = quat.create(); let s = vec3.create();
                return { t: mat4.getTranslation(t, m), r: mat4.getRotation(r, m), s: mat4.getScaling(s, m) };
            };

            const setNodeMatrix = (node: GLTFNode, mat: mat4) => {
                let trs = getTRS(mat);
                node.setTranslation([trs.t[0], trs.t[1], trs.t[2]]);
                quat.normalize(trs.r, trs.r);
                node.setRotation([trs.r[0], trs.r[1], trs.r[2], trs.r[3]]);
                node.setScale([trs.s[0], trs.s[1], trs.s[2]]);
            }

            const globalBuffer = doc.createBuffer();

            let chunkTotalIdx = 0;

            let emitObject = (object: LevelObject, dynInstMat: (mat4 | null) = null) => {
                // if (object.header.index != 269)
                //     return;

                // let objNode = doc.createNode(`obj: [${object.header.index}] ${object.header.name}`);
                // setNodeMatrix(objNode, dynInstMat);
                // rootNode.addChild(objNode);

                for (let meshContainer of object.meshContainers) {
                    // let meshContNode = doc.createNode(`mco: [${meshContainer.containerIndex}] ${hexzero(meshContainer.offset)}`);
                    // objNode.addChild(meshContNode);

                    let meshIdx = 0;
                    for (let mesh of meshContainer.meshes) {
                        // let meshNode = doc.createNode(`mesh: [${mesh.meshIndex}] T${mesh.type} ${hexzero(mesh.offset)}`);
                        // meshContNode.addChild(meshNode);

                        // todo: do mesh instancing/cache at this level. solves instancing problem

                        let meshInstanceMatrices = [mat4.create()];

                        meshInstanceMatrices = meshInstanceMatrices.concat([...mesh.instances]);

                        let transformC2: (mat4 | null) = null;
                        if (mesh.u0 == 0) {
                            transformC2 = meshContainer.meshC2Entries[mesh.containerInstanceMatrixIndex].transformMatrix;

                            // if (transformC2) {
                            //     for (let i = 0; i < meshInstanceMatrices.length; ++i) {
                            //         mat4.multiply(meshInstanceMatrices[i], meshInstanceMatrices[i], transformC2!);
                            //         // mat4.multiply(meshInstanceMatrices[i], transformC2!, meshInstanceMatrices[i]);
                            //     }
                            // }
                        }

                        let instanceIdx = 0;
                        for (let meshInstanceMatrix of meshInstanceMatrices) {
                            // let meshInstNode = doc.createNode(`meshInst: ${instanceIdx}`);
                            // setNodeMatrix(meshInstNode, meshInstanceMatrix);
                            // meshNode.addChild(meshInstNode);

                            let meshInstMatrix = mat4.create();
                            if (transformC2)
                                mat4.multiply(meshInstMatrix, transformC2!, meshInstMatrix);
                            if (dynInstMat)
                                mat4.multiply(meshInstMatrix, dynInstMat!, meshInstMatrix);
                            else
                                mat4.multiply(meshInstMatrix, meshInstanceMatrix, meshInstMatrix);
                            mat4.multiply(meshInstMatrix, rootMatrix, meshInstMatrix);

                            let chunkIdx = 0;
                            for (let chunk of mesh.chunks) {
                                // let meshInstChunkNode = doc.createNode(`meshInstChunk: ${instanceIdx}`);
                                // meshInstNode.addChild(meshInstChunkNode);

                                if (!chunk.gltfMesh &&
                                    chunk.positions.length && chunk.normals.length && chunk.texCoords.length &&
                                    (chunk.trianglesIndices1.length || chunk.trianglesIndices2.length)) {
                                    // todo: redundant creates ?

                                    const szme = mesh.szme.chunks[chunkIdx];

                                    const position = doc.createAccessor()
                                        .setType(Accessor.Type.VEC3)
                                        .setArray(chunk.positions)
                                        .setBuffer(globalBuffer);
                                    const normal = doc.createAccessor()
                                        .setType(Accessor.Type.VEC3)
                                        .setArray(chunk.normals)
                                        .setBuffer(globalBuffer);
                                    const texcoord = doc.createAccessor()
                                        .setType(Accessor.Type.VEC2)
                                        .setArray(chunk.texCoords)
                                        .setBuffer(globalBuffer);

                                    const prim = doc.createPrimitive()
                                        .setAttribute('POSITION', position)
                                        .setAttribute('NORMAL', normal)
                                        .setAttribute('TEXCOORD_0', texcoord);

                                    let meshGltf = doc.createMesh();

                                    if (chunk.trianglesIndices1.length) {
                                        const indices1 = doc.createAccessor()
                                            .setType(Accessor.Type.SCALAR)
                                            .setArray(chunk.trianglesIndices1)
                                            .setBuffer(globalBuffer);
                                        const mat1 = !MESH_EXPORT_GLTF_MATERIALS ? null :
                                            texIdToMaterialMap.get(`${object.header.index}_${szme!.textureId0}`) || null;
                                        const prim1 = prim.clone()
                                            .setMaterial(mat1)
                                            .setIndices(indices1);
                                        meshGltf.addPrimitive(prim1);
                                    }
                                    if (chunk.trianglesIndices2.length) {
                                        const indices2 = doc.createAccessor()
                                            .setType(Accessor.Type.SCALAR)
                                            .setArray(chunk.trianglesIndices2)
                                            .setBuffer(globalBuffer);
                                        const mat2 = !MESH_EXPORT_GLTF_MATERIALS ? null :
                                            texIdToMaterialMap.get(`${object.header.index}_${szme!.textureId1}`) || null;
                                        const prim2 = prim.clone()
                                            .setMaterial(mat2)
                                            .setIndices(indices2);
                                        meshGltf.addPrimitive(prim2);
                                    }

                                    chunk.gltfMesh = meshGltf;
                                }

                                // meshInstNode.setMesh(chunk.gltfMesh);

                                let meshInstNode = doc.createNode()
                                    .setName(`${mesh.container.containerIndex}_[${object.header.index}]${object.header.name}_${mesh.meshIndex}_${chunkIdx}_${instanceIdx}_${chunkTotalIdx}_${hexzero(mesh.offset)}`);
                                meshInstNode.setMesh(chunk.gltfMesh);

                                setNodeMatrix(meshInstNode, meshInstMatrix);
                                mainScene.addChild(meshInstNode);

                                chunkIdx++;
                                chunkTotalIdx++;
                            }
                            instanceIdx++;

                            if (dynInstMat)
                                break;
                        }
                        meshIdx++;
                    }
                }
            };

            for (let object of objects) {
                // let objDynInstMats = objIdxToObjDynInstMatsMap.get(object.header.index) || [];
                // emitObject(object, objDynInstMats);

                let objDynInstMats = objIdxToObjDynInstMatsMap.get(object.header.index);
                if (objDynInstMats) {
                    for (let objDynInstMat of objDynInstMats) {
                        emitObject(object, objDynInstMat);
                    }
                    emitObject(object);
                } else {
                    emitObject(object);
                }
            }

            const glb = io.writeBinary(doc);
            downloadBuffer(`${this.id}.glb`, glb);
        }

        let texIdToTex = new Map<string, Texture>();

        const addTexturesAndMaterials = async (object: LevelObject, textures: (Texture | null)[]) => {
            await Promise.all(textures.filter((texture) => texture !== null).map(async (texture) => {
                const surface = texture!.toCanvas().surfaces[0];
                const blob: (Blob | null) = await new Promise((resolve, reject) => {
                    surface.toBlob((blob: Blob | null) => blob !== null ? resolve(blob) : reject(null));
                });
                if (blob) {
                    texIdToTex.set(`${object.header.index}_${texture!.texEntryIdx}`, texture!);
                }
            }));
        };
        for (let object of objects) {
            await addTexturesAndMaterials(object, object.texturesDiffuse);
            // await addTexturesAndMaterials(object, object.texturesUnk);
        }

        const renderer = new Sly2Renderer(device, objects, dynObjectInsts, texIdToTex);
        return renderer;
    }
}

// From https://docs.google.com/spreadsheets/d/1bdhTl2IvXVWOjnjhpgUTH0kg6e-RcioezIYrsi-_mso/edit#gid=0
// TODO: Should titles be world titles instead of ep?
const sceneDescs = [
    "Main Hubs",
    new Sly2LevelSceneDesc("jb_intro", "P. A Shadow from the Past (Cairo, Egypt)"),
    new Sly2LevelSceneDesc("f_nightclub_exterior", "1. The Black Chateau (Paris, France)"),
    new Sly2LevelSceneDesc("i_palace_ext", "2. A Starry Eyed Encounter (Rajan's palace, India)"),
    new Sly2LevelSceneDesc("i_temple_ext", "3. The Predator Awakes (Spice temple, India)"),
    new Sly2LevelSceneDesc("p_prison_ext", "4. Jailbreak (The Contessa's prison, Prague)"),
    new Sly2LevelSceneDesc("p_castle_ext", "5. A Tangled Web (Contessa's castle, Prague)"),
    new Sly2LevelSceneDesc("c_train_ext", "6. He Who Tames the Iron Horse (Nunavut Bay, Canada)"),
    new Sly2LevelSceneDesc("c_sawmill_ext", "7. Menace from the North, eh! (Lumber camp, Canada)"),
    new Sly2LevelSceneDesc("a_blimp_ext", "8. Anatomy for Disaster (Arpeggio's blimp)"),
    "Other",
    new Sly2LevelSceneDesc("dvd_menu", "dvd_menu"),
];

const id = 'Sly2';
const name = 'Sly 2: Band of Thieves';
export const sceneGroup: SceneGroup = { id, name, sceneDescs };
