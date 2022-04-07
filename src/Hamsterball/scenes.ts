
import { NamedArrayBufferSlice } from "../DataFetcher";
import { GfxDevice } from "../gfx/platform/GfxPlatform";
import { SceneContext, SceneDesc, SceneGroup } from "../SceneBase";
import { downloadCanvasAsPng, downloadText } from "../DownloadUtils";
import { SceneGfx } from "../viewer";
import { parseMESHWORLD } from "./bin";
import { Scene } from "./render";

const pathBase = `Hamsterball`;

const DUMP_OBJ = false;

export class HamsterballSceneDesc implements SceneDesc {
    constructor(public id: string, public name: string = id) {
    }

    public async createScene(device: GfxDevice, sceneContext: SceneContext): Promise<SceneGfx> {
        const meshworld = parseMESHWORLD(await sceneContext.dataFetcher.fetchData(`${pathBase}/Levels/${this.id}.MESHWORLD`));
        // const meshworld = parseCACHED(await sceneContext.dataFetcher.fetchData(`${pathBase}/Levels/${this.id.toLowerCase()}.cached`));

        if (DUMP_OBJ) {
            let obj_str = "";
            // obj_str += `mtllib ${this.id}.mtl\n`;

            obj_str += `g all\n`;
            obj_str += `s off\n`;

            const vertexCount = meshworld.vertexData.positions.length / 3;
            for (let i = 0; i < vertexCount; ++i) {
                const px = meshworld.vertexData.positions[i * 3 + 0];
                const py = meshworld.vertexData.positions[i * 3 + 1];
                const pz = meshworld.vertexData.positions[i * 3 + 2];

                obj_str += `v ${px} ${py} ${pz}\n`;

                const pnx = meshworld.vertexData.normals[i * 3 + 0];
                const pny = meshworld.vertexData.normals[i * 3 + 1];
                const pnz = meshworld.vertexData.normals[i * 3 + 2];

                obj_str += `vn ${pnx} ${pny} ${pnz}\n`;

                const ptu = meshworld.vertexData.texcoords[i * 2 + 0];
                const ptv = meshworld.vertexData.texcoords[i * 2 + 1];

                obj_str += `vt ${ptu} ${ptv}\n`;
            }

            // TODO

            // const indexCount = meshworld.indexData.length;
            // for (let i = 0; i < indexCount / 3; ++i) {
            //     const f0 = meshworld.indexData[i * 3 + 0] + 1;
            //     const f1 = meshworld.indexData[i * 3 + 1] + 1;
            //     const f2 = meshworld.indexData[i * 3 + 2] + 1;

            //     obj_str += `f ${f0}/${f0}/${f0} ${f1}/${f1}/${f1} ${f2}/${f2}/${f2}\n`;
            // }

            // const triangleCount = vertexCount / 3 - 3;
            // for (let i = 0; i < triangleCount; ++i) {
            //     const f0 = i * 3 + 1;
            //     const f1 = i * 3 + 2;
            //     const f2 = i * 3 + 3;

            //     obj_str += `f ${f0}//${f0} ${f1}//${f1} ${f2}//${f2}\n`;
            // }

            // const triangleCount = vertexCount / 3 - 2 - 1;
            // for (let i = 0; i < triangleCount; ++i) {
            //     const f0 = i + 1;
            //     const f1 = i + 2;
            //     const f2 = i + 3;

            //     obj_str += `f ${f0}//${f0} ${f1}//${f1} ${f2}//${f2}\n`;
            // }

            // const quadCount = vertexCount / 4 - 4;
            // for (let i = 0; i < quadCount; ++i) {
            //     const f0 = i * 4 + 1;
            //     const f1 = i * 4 + 2;
            //     const f2 = i * 4 + 3;
            //     const f3 = i * 4 + 4;

            //     obj_str += `f ${f0}//${f0} ${f1}//${f1} ${f2}//${f2} ${f3}//${f3}\n`;
            // }

            downloadText(`${this.id}.obj`, obj_str);
        }

        let scene = new Scene(device, sceneContext, meshworld);
        await scene.init();
        return scene;
    }
}

const sceneDescs = [
    new HamsterballSceneDesc("Arena-Beginner"),
    new HamsterballSceneDesc("Arena-Dizzy"),
    new HamsterballSceneDesc("Arena-Intermediate"),
    new HamsterballSceneDesc("Arena-Neon"),
    new HamsterballSceneDesc("Arena-SpawnPlatform"),
    new HamsterballSceneDesc("Arena-Stands"),
    new HamsterballSceneDesc("Arena-Tower"),
    new HamsterballSceneDesc("Arena-Up"),
    new HamsterballSceneDesc("Arena-WarmUp"),
    new HamsterballSceneDesc("Level1"),
    new HamsterballSceneDesc("Level2-Bridge"),
    new HamsterballSceneDesc("Level2"),
    new HamsterballSceneDesc("Level3-Gluebie"),
    new HamsterballSceneDesc("Level3-Swirl"),
    new HamsterballSceneDesc("Level3-Tipper"),
    new HamsterballSceneDesc("Level3-WaterWheel"),
    new HamsterballSceneDesc("Level3"),
    new HamsterballSceneDesc("Level4-Catapult"),
    new HamsterballSceneDesc("Level4-Drawbridge"),
    new HamsterballSceneDesc("Level4-Mace"),
    new HamsterballSceneDesc("Level4-Trapdoor1"),
    new HamsterballSceneDesc("Level4-Trapdoor2"),
    new HamsterballSceneDesc("Level4-Turret"),
    new HamsterballSceneDesc("Level4-Windmill"),
    new HamsterballSceneDesc("Level4"),
    new HamsterballSceneDesc("Level6-Lifter"),
    new HamsterballSceneDesc("LevelCascade"),
    new HamsterballSceneDesc("LevelDark-DFloor1"),
    new HamsterballSceneDesc("LevelDark-DFloor2"),
    new HamsterballSceneDesc("LevelDark-DFloor3"),
    new HamsterballSceneDesc("LevelDark-DFloor4"),
    new HamsterballSceneDesc("LevelDark-FlickRing"),
    new HamsterballSceneDesc("LevelDark-NeonPlatform"),
    new HamsterballSceneDesc("LevelDark-Trode"),
    new HamsterballSceneDesc("LevelDark"),
    new HamsterballSceneDesc("LevelUp-Button"),
    new HamsterballSceneDesc("LevelUp-Lifter"),
    new HamsterballSceneDesc("LevelUp-SpeedCylinder"),
    new HamsterballSceneDesc("LevelUp"),
    new HamsterballSceneDesc("MouseTrap"),
    new HamsterballSceneDesc("PopupSign"),
    new HamsterballSceneDesc("Secret-Unlock"),
    new HamsterballSceneDesc("Secret"),
];

const id = "Hamsterball";
const name = "Hamsterball";
export const sceneGroup: SceneGroup = { id, name, sceneDescs };
