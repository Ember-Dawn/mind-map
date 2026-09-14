<template>
  <div class="imgUploadContainer">
    <div class="imgUploadPanel">
      <div class="upBtn" v-if="!value">
        <label
          for="imgUploadInput"
          class="imgUploadInputArea"
          @dragenter.stop.prevent
          @dragover.stop.prevent
          @drop.stop.prevent="onDrop"
          >点击此处选择图片、或拖动图片到此</label
        >
        <input
          type="file"
          accept="image/*"
          id="imgUploadInput"
          @change="onImgUploadInputChange"
        />
      </div>
      <div v-if="value" class="uploadInfoBox">
        <div
          class="previewBox"
          :style="{ backgroundImage: `url('${value}')` }"
        ></div>
        <span class="delBtn el-icon-close" @click="deleteImg"></span>
      </div>
    </div>
  </div>
</template>

<script>
import { uploadImage } from '@/utils/imageUpload'

export default {
  model: {
    prop: 'value',
    event: 'change'
  },
  props: {
    value: {
      type: String,
      default: ''
    }
  },
  data() {
    return {
      file: null,
      imageSize: null
    }
  },
  methods: {
    // 图片选择事件
    onImgUploadInputChange(e) {
      let file = e.target.files[0]
      this.selectImg(file)
    },

    // 拖动上传图片
    onDrop(e) {
      let dt = e.dataTransfer
      let file = dt.files && dt.files[0]
      this.selectImg(file)
    },

    // 选择图片
    async selectImg(file) {
      if (!file) return
      this.file = file
      try {
        const result = await uploadImage(file)
        this.imageSize = result.size
        this.$emit('change', result.url)
      } catch (error) {
        console.error('[Image Upload] Failed:', error)
        this.$message.error(error?.message || '图片处理失败')
        this.file = null
        this.imageSize = null
      }
    },

    // 获取图片大小
    getSize() {
      if (this.imageSize) return Promise.resolve(this.imageSize)
      return new Promise(resolve => {
        let img = new Image()
        img.src = this.value
        img.onload = () => {
          resolve({
            width: img.width,
            height: img.height
          })
        }
        img.onerror = () => {
          resolve({
            width: 0,
            height: 0
          })
        }
      })
    },

    // 删除图片
    deleteImg() {
      this.$emit('change', '')
      this.file = null
      this.imageSize = null
    }
  }
}
</script>

<style lang="less" scoped>
@import './style.less';
</style>
