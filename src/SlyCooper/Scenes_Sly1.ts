import ArrayBufferSlice from '../ArrayBufferSlice';
import { mat4, vec2, vec3 } from 'gl-matrix';
import { SceneGroup, SceneDesc, SceneGfx, ViewerRenderInput } from "../viewer";
import * as Viewer from "../viewer";
import { GfxDevice } from "../gfx/platform/GfxPlatform";
import { SceneContext } from "../SceneBase";
import { IS_DEVELOPMENT } from "../BuildVersion";
import { assert, hexzero, hexzero0x, leftPad } from '../util';
import { NamedArrayBufferSlice } from "../DataFetcher";
import { downloadCanvasAsPng, downloadText } from "../DownloadUtils";
import { range, range_end } from '../MathHelpers';
import { downloadBuffer } from '../DownloadUtils';
import { makeZipFile, ZipFileEntry } from '../ZipFile';
import { SlyRenderer } from './SlyRenderer';
import * as Settings from './SlyConstants';
import * as Data from './SlyData';
import { DataStream } from "./DataStream";
import { sprintf } from "./sprintf";

const pathBase = `Sly1`;

function Uint8Array_indexOfMulti(arr: Uint8Array, searchElements: Uint8Array, fromIndex: number = 0): number {
    var index = arr.indexOf(searchElements[0], fromIndex);

    if (searchElements.length === 1 || index === -1) {
        // Not found or no other elements to check
        return index;
    }

    for (var i = index, j = 0; j < searchElements.length && i < arr.length; i++, j++) {
        if (arr[i] !== searchElements[j]) {
            return Uint8Array_indexOfMulti(arr, searchElements, index + 1);
        }
    }

    return (i === index + searchElements.length) ? index : -1;
};

class Sly1LevelSceneDesc implements SceneDesc {
    private meshContainers: Data.MeshContainer[] = [];
    private texturesDiffuse: (Data.Texture | null)[] = [];
    private texturesAmbient: (Data.Texture | null)[] = [];
    private texturesUnk: (Data.Texture | null)[] = [];

    constructor(public id: string, public name: string, private tex_pal_offs: number) {
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<SceneGfx> {
        // TODO? Use compressed original files (orig. or zip/etc), or decompressed trimmed files

        const bin = await context.dataFetcher.fetchData(`${pathBase}/${this.id}.slyW.dec`)

        console.log(`loaded ${pathBase}/${this.id}_W.dec of size ${bin.byteLength}`);

        // TODO: will we need to copy those?

        // this.textures.push(new Texture(bin.slice(0x93c640 ), bin.slice(0xA01100), 1024, 1024));
        // this.textures.push(new Texture(bin.slice(0x93c640 + 0x400), bin.slice(0xA01100 + 0x100000), 1024, 1024));
        // this.textures.push(new Texture(bin.slice(0x93c640 + 0x400*2), bin.slice(0xA01100 + 0x100000*2), 1024, 1024));
        // this.textures.push(new Texture(bin.slice(0x93c640 + 0x400*3), bin.slice(0xA01100 + 0x100000*3), 1024, 1024));
        // this.textures.push(new Texture(bin.slice(0x93c640 + 0x400*4), bin.slice(0xA01100 + 0x100000*4), 1024, 1024));

        // for (let i of range_end(200 * 0x400, 400 * 0x400, 0x400)) {
        // for (let i of range_end(319 * 0x400, 320 * 0x400, 0x400)) {
        //     this.textures.push(new Texture(
        //         bin.slice(0x93c640 + i), bin.slice(0xA01100 + 0x100000 * 2), 1024, 1024, (i / 0x400).toString()));
        // }

        const binU8arr = bin.createTypedArray(Uint8Array);
        let enc = new TextEncoder();
        // TODO: verify it works for every level
        const tex_meta_offs = Uint8Array_indexOfMulti(binU8arr, enc.encode("FK$Dcrmtaunt07")) + 0x20;
        console.log(`tex_meta_offs ${hexzero0x(tex_meta_offs)}`);

        let textureInfoStream = new DataStream(bin.slice(tex_meta_offs));

        const clutMetaEntries = Data.parseCLUTMetaEntries(textureInfoStream);
        const imageMetaEntries = Data.parseImageMetaEntries(textureInfoStream);
        const textureEntries = Data.parseTextureEntries(textureInfoStream);

        console.log(`clut#: ${clutMetaEntries.length}`);
        console.log(`img #: ${imageMetaEntries.length}`);
        console.log(`tex #: ${textureEntries.length}`);

        enum TextureType {
            Diffuse,
            Ambient,
            Unk
        }

        for (let i = 0; i < textureEntries.length; ++i) {
            this.texturesDiffuse.push(null);
            this.texturesAmbient.push(null);
            this.texturesUnk.push(null);
        }

        let texEntryIdx = 0;
        for (let texEntry of textureEntries) {
            let makeTexture = (clutIndex: number, imageIndex: number, type: TextureType = TextureType.Diffuse) => {
                if (clutIndex >= clutMetaEntries.length) {
                    console.warn(`warn: [id ${texEntryIdx}] clutIndex (${clutIndex}) out of bounds, skipping`);
                    return;
                }
                if (imageIndex >= imageMetaEntries.length) {
                    console.warn(`warn: [id ${texEntryIdx}] imageIndex (${imageIndex}) out of bounds, skipping`);
                    return;
                }
                let clutMeta = clutMetaEntries[clutIndex];
                let imageMeta = imageMetaEntries[imageIndex];

                const width = imageMeta.width;
                const height = imageMeta.height;
                // console.log(`clutMeta: ${clutMeta.offset} imageMeta: ${imageMeta.offset}`);
                // console.log(`w: ${width} h: ${height} C: ${hexzero(clutMeta.offset, 8)} I: ${hexzero(imageMeta.offset, 8)}`);
                const paletteBuf = bin.slice(this.tex_pal_offs + clutMeta.offset);
                const imageBuf = bin.slice(this.tex_pal_offs + imageMeta.offset)

                let typeStr = '';
                switch (type) {
                    case TextureType.Diffuse: typeStr = 'Dif'; break;
                    case TextureType.Ambient: typeStr = 'Amb'; break;
                    case TextureType.Unk: typeStr = 'Unk'; break;
                }

                const name = sprintf(`Id %03d-%03d-%03d Res %04dx%04d Clt %05X Img %06X Cols %03d Type %s`,
                    texEntryIdx, clutIndex, imageIndex, width, height, clutMeta.offset, imageMeta.offset, clutMeta.colorCount, typeStr);
                const texture = new Data.Texture(texEntryIdx, paletteBuf, imageBuf, width, height, clutMeta.colorCount, clutMeta.colorSize, name);

                switch (type) {
                    case TextureType.Diffuse:
                        this.texturesDiffuse[texEntryIdx] = texture;
                        break;
                    case TextureType.Ambient:
                        this.texturesAmbient[texEntryIdx] = texture;
                        break;
                    case TextureType.Unk:
                        this.texturesUnk[texEntryIdx] = texture;
                        break;
                }
            };

            const is1Img1Pal = (texEntry.clutIndices.length == texEntry.imageIndices.length);
            const is1ImgManyPal = (texEntry.imageIndices.length == 1) && (texEntry.clutIndices.length > 1);
            const isManyImgManyPal = !is1Img1Pal && (texEntry.imageIndices.length > 1) && (texEntry.clutIndices.length > 1);

            if (is1Img1Pal) {
                // for (let i = 0; i < texEntry.clutIndices.length; i++) {
                //     makeTexture(texEntry.clutIndices[i], texEntry.imageIndices[i]);
                // }
                // console.log(`1img1pal: CLUT:[${texEntry.clutIndices}] IMG[${texEntry.imageIndices}]`);
                // Use first one
                makeTexture(texEntry.clutIndices[0], texEntry.imageIndices[0]);
            } else if (is1ImgManyPal) {
                // for (let palIndex of texEntry.clutIndices) {
                //     makeTexture(palIndex, texEntry.imageIndices[0]);
                // }
                // console.log(`1imgNpal: CLUT:[${texEntry.clutIndices}] IMG[${texEntry.imageIndices}]`);

                if (texEntry.clutIndices.length == 3) {
                    makeTexture(texEntry.clutIndices[0], texEntry.imageIndices[0], TextureType.Ambient);
                    makeTexture(texEntry.clutIndices[1], texEntry.imageIndices[0], TextureType.Diffuse);
                    makeTexture(texEntry.clutIndices[2], texEntry.imageIndices[0], TextureType.Unk);
                } else {
                    makeTexture(texEntry.clutIndices[0], texEntry.imageIndices[0]);
                }

            } else if (isManyImgManyPal) {
                if (!Number.isInteger(texEntry.clutIndices.length / texEntry.imageIndices.length)) {
                    console.log(`WARN: nonint m2m ${texEntryIdx} ${texEntry.clutIndices.length} ${texEntry.imageIndices.length}`);
                }
                // const divPalImg = Math.floor(texEntry.clutIndices.length / texEntry.imageIndices.length);
                // for (let i = 0; i < texEntry.clutIndices.length; ++i) {
                //     let imgIndex = Math.floor(i / divPalImg);
                //     makeTexture(texEntry.clutIndices[i], texEntry.imageIndices[imgIndex]);
                // }
                // console.log(`NimgMpal: CLUT:[${texEntry.clutIndices}] IMG[${texEntry.imageIndices}]`);
                // Use first ones
                makeTexture(texEntry.clutIndices[0], texEntry.imageIndices[0]);
            } else {
                console.log(`WARN: other ${texEntryIdx} ${texEntry.clutIndices.length} ${texEntry.imageIndices.length}`);
            }
            texEntryIdx++;
        }

        // if (Settings.TEXTURES_SORT_BY_SIZE) {
        // this.textures.sort((texA: Data.Texture, texB: Data.Texture) => (texA.width * texA.height > texB.width * texB.height) ? -1 : 1);
        // }

        if (Settings.PARSE_MESHES) {
            this.meshContainers = Data.parseMeshes(bin);

            console.log(`Mesh Container #: ${this.meshContainers.length}`);

            // export to .obj

            if (Settings.MESH_EXPORT) {
                let obj_str = `mtllib ${this.id}.mtl\n`;

                let face_idx_base = 1;

                let meshIdx = 0;
                let chunkTotalIdx = 0;
                for (let meshContainer of this.meshContainers) {
                    let chunkIdx = 0;

                    for (let mesh of meshContainer.meshes) {
                        if (!Settings.SEPARATE_OBJECT_SUBMESHES) {
                            obj_str += `o ${mesh.container.containerIndex}_${mesh.meshIndex}_${chunkTotalIdx}_${hexzero0x(mesh.offset)}\n`;
                        }

                        let meshInstanceMatrices = [mat4.create()];

                        const meshInstances = meshContainer.meshInstancesMap.get(mesh.meshIndex);
                        if (meshInstances)
                            for (let meshInstance of meshInstances)
                                meshInstanceMatrices.push(meshInstance.instanceMatrix);

                        let instanceIdx = 0;
                        for (let meshInstanceMatrix of meshInstanceMatrices) {
                            for (let chunk of mesh.chunks) {
                                if (Settings.SEPARATE_OBJECT_SUBMESHES) {
                                    obj_str += `o ${mesh.container.containerIndex}_${mesh.meshIndex}_${instanceIdx}_${chunkIdx}_${chunkTotalIdx}_${hexzero0x(mesh.offset)}\n`;
                                } else {
                                    obj_str += `g ${mesh.container.containerIndex}_${mesh.meshIndex}_${instanceIdx}_${chunkIdx}_${chunkTotalIdx}_${hexzero0x(mesh.offset)}\n`;
                                }

                                if (instanceIdx == 0) {
                                    for (let i = 0; i < chunk.positions.length; i += 3) {
                                        const pos = vec3.fromValues(chunk.positions[i + 0], chunk.positions[i + 1], chunk.positions[i + 2]);

                                        let scaledPos = vec3.fromValues(
                                            pos[0] * Settings.MESH_SCALE,
                                            pos[1] * Settings.MESH_SCALE,
                                            pos[2] * Settings.MESH_SCALE);

                                        obj_str += `v ${scaledPos[0]} ${scaledPos[1]} ${scaledPos[2]}\n`;
                                    }
                                } else {
                                    let newPos = vec3.create();

                                    for (let i = 0; i < chunk.positions.length; i += 3) {
                                        const pos = vec3.fromValues(chunk.positions[i + 0], chunk.positions[i + 1], chunk.positions[i + 2]);

                                        vec3.transformMat4(newPos, pos, meshInstanceMatrix);

                                        let scaledPos = vec3.fromValues(
                                            newPos[0] * Settings.MESH_SCALE,
                                            newPos[1] * Settings.MESH_SCALE,
                                            newPos[2] * Settings.MESH_SCALE);

                                        obj_str += `v ${scaledPos[0]} ${scaledPos[1]} ${scaledPos[2]}\n`;
                                    }
                                }

                                for (let i = 0; i < chunk.normals.length; i += 3) {
                                    let normal = vec3.fromValues(chunk.normals[i], chunk.normals[i + 1], chunk.normals[i + 2]);

                                    obj_str += `vn ${normal[0]} ${normal[1]} ${normal[2]}\n`;
                                }

                                for (let i = 0; i < chunk.texCoords.length; i += 2) {
                                    let texCoord = vec2.fromValues(chunk.texCoords[i], chunk.texCoords[i + 1]);

                                    obj_str += `vt ${texCoord[0]} ${texCoord[1]}\n`;
                                }

                                //obj_str += `s off\n`;
                                if (chunk.szme)
                                    obj_str += `usemtl ${chunk.szme!.texIndex}\n`
                                else
                                    obj_str += `usemtl empty\n`;

                                for (let i = 0; i < chunk.trianglesIndices.length; i += 3) {
                                    const f0 = face_idx_base + chunk.trianglesIndices[i + 0];
                                    const f1 = face_idx_base + chunk.trianglesIndices[i + 1];
                                    const f2 = face_idx_base + chunk.trianglesIndices[i + 2];

                                    obj_str += `f ${f0}/${f0}/${f0} ${f1}/${f1}/${f1} ${f2}/${f2}/${f2}\n`;
                                }
                                face_idx_base += chunk.positions.length / 3;

                                chunkIdx++;
                                chunkTotalIdx++;
                            }
                            meshIdx++;
                            instanceIdx++;
                        }
                    }
                }

                downloadText(`${this.id}.obj`, obj_str);


                let mat_str = 'newmtl empty\n';

                for (let texture of this.texturesDiffuse) {
                    if (texture) {
                        mat_str += `newmtl ${texture.texEntryIdx}\n`;
                        mat_str += `map_Kd ${this.id}_textures/${texture.name}.png\n`;
                    }
                }

                downloadText(`${this.id}.mtl`, mat_str);
            }
        }

        const renderer = new SlyRenderer(device, this.meshContainers, this.texturesDiffuse, this.texturesAmbient, this.texturesUnk, textureEntries);

        let addTexToViewer = async (tex: (Data.Texture | null)) => {
            if (tex)
                renderer.textureHolder.viewerTextures.push(tex.toCanvas());
        };

        for (let i = 0; i < this.texturesDiffuse.length; i++) {
            addTexToViewer(this.texturesDiffuse[i]);
            addTexToViewer(this.texturesAmbient[i]);
            addTexToViewer(this.texturesUnk[i]);
        }

        if (Settings.TEXTURES_EXPORT) {
            let zipFileEntries: ZipFileEntry[] = [];

            const dumpTextures = async (textures: (Data.Texture | null)[]) => {
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

            await dumpTextures(this.texturesDiffuse);
            await dumpTextures(this.texturesAmbient);
            await dumpTextures(this.texturesUnk);

            console.log(zipFileEntries);

            const zipFile = makeZipFile(zipFileEntries);
            downloadBuffer(`${this.id}_textures.zip`, zipFile);
        }

        return renderer;
    }
}

// From https://docs.google.com/spreadsheets/d/1bdhTl2IvXVWOjnjhpgUTH0kg6e-RcioezIYrsi-_mso/edit#gid=0
// TODO: Should titles be world titles instead of ep?
const sceneDescs = [
    "Police Headquarters (Paris, France)",
    new Sly1LevelSceneDesc("jb_intro", "Paris, France", 0xb12960),

    "Tide of Terror (Isle of Wrath, Wales)",
    new Sly1LevelSceneDesc("uw_exterior_approach", "A Stealthy Approach", 0x93c640),
    new Sly1LevelSceneDesc("uw_exterior_boat", "Prowling the Grounds", 0x007Ca240),
    new Sly1LevelSceneDesc("uw_c2_final", "Into the Machine", 0x8b09c0),
    new Sly1LevelSceneDesc("uw_bonus_security", "High Class Heist", 0x64e6a0),
    new Sly1LevelSceneDesc("uw_bonus_drivewheels", "The Fire Down Below", 0x624b70),
    new Sly1LevelSceneDesc("uw_bonus_library", "A Cunning Disguise", 0x665370),
    new Sly1LevelSceneDesc("uw_t3_final", "Gunboat Graveyard", 0x87de10),
    new Sly1LevelSceneDesc("uw_rip_off", "Treasure in the Depths", 0xaadb0),
    new Sly1LevelSceneDesc("uw_boss_blimp", "The Eye of the Storm", 0x38ee80),

    "Sunset Snake Eyes (Mesa City, Utah)",
    new Sly1LevelSceneDesc("ms_approach", "A Rocky Start", 0xa63cc0),
    new Sly1LevelSceneDesc("ms_exterior", "Muggshot's Turf", 0x975ac0),
    new Sly1LevelSceneDesc("ms_casino", "Boneyard Casino", 0x7c29b0),
    new Sly1LevelSceneDesc("ms_sniper", "Murray's Big Gamble", 0x65F860),
    new Sly1LevelSceneDesc("ms_suv", "At the Dog Track", 0x794460),
    new Sly1LevelSceneDesc("ms_inspector", "Two to Tango", 0x851a60),
    new Sly1LevelSceneDesc("ms_vertigo", "Back Alley Heist", 0x67b570),
    new Sly1LevelSceneDesc("ms_rooftop", "Straight to the Top", 0x74c890),
    new Sly1LevelSceneDesc("ms_boss_battle", "Last Call", 0x4fe9d0),

    "Vicious Voodoo (Haiti)",
    new Sly1LevelSceneDesc("v_approach", "The Dread Swamp Path", 0x8364f0),
    new Sly1LevelSceneDesc("v_hub", "The Swamp's Dark Center", 0x9c2710),
    new Sly1LevelSceneDesc("v_swamp_monster", "The Lair of the Beast", 0x876db0),
    new Sly1LevelSceneDesc("v_gomerville", "A Grave Undertaking", 0x8b75d0),
    new Sly1LevelSceneDesc("v_puffer", "Piranha Lake", 0x4bc1e0),
    new Sly1LevelSceneDesc("v_skinterior", "Descent Into Danger", 0x8d1560),
    new Sly1LevelSceneDesc("v_murray", "A Ghastly Voyage", 0x71e690),
    new Sly1LevelSceneDesc("v_chicken", "Down Home Cooking", 0x2bf6b0),
    new Sly1LevelSceneDesc("v_boss", "A Deadly Dance", 0x8036f0),

    "Fire in the Sky (Kunlun Mountains, China)",
    new Sly1LevelSceneDesc("s_approach", "A Perilous Ascent", 0x9cf990),
    new Sly1LevelSceneDesc("s_hub", "Inside the Stronghold", 0x87EA00),
    new Sly1LevelSceneDesc("s_security", "Flaming Temple of Flame", 0x9c2320),
    new Sly1LevelSceneDesc("s_barrel", "The Unseen Foe", 0x797f60),
    new Sly1LevelSceneDesc("s_sniper", "The King of the Hill", 0x6eb220),
    new Sly1LevelSceneDesc("s_tank", "Rapid Fire Assault", 0x7c0240),
    new Sly1LevelSceneDesc("s_suv", "A Desperate Race", 0x4a7130),
    new Sly1LevelSceneDesc("s_inspector", "Duel by the Dragon", 0xa5a000),
    new Sly1LevelSceneDesc("s_boss", "Flame Fu!", 0x3B13D0),

    "The Cold Heart of Hate (Krakarov Volcano, Russia)",
    new Sly1LevelSceneDesc("cw_turret", "A Hazardous Path", 0x504990),
    new Sly1LevelSceneDesc("cw_suv", "Burning Rubber", 0x2f2d80),
    new Sly1LevelSceneDesc("cw_security", "A Daring Rescue", 0x560b30),
    new Sly1LevelSceneDesc("cw_bentley", "Bentley Comes Through", 0x2498e0),
    new Sly1LevelSceneDesc("cw_reverse_sniper", "A Temporary Truce", 0x514920),
    new Sly1LevelSceneDesc("cw_outclimb", "Sinking Peril", 0x5b5b90),
    new Sly1LevelSceneDesc("cw_finish", "A Strange Reunion", 0x6ee1a0),

    "Miscellaneous",
    new Sly1LevelSceneDesc("splash", "Splash", 0x1a930),
    new Sly1LevelSceneDesc("hideout", "The Hideout", 0x388000)
];

const id = 'Sly1';
const name = 'Sly Cooper and the Thievius Raccoonus';
export const sceneGroup: SceneGroup = { id, name, sceneDescs };
