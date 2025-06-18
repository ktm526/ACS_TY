import { useState } from 'react';

const usePasswordConfirm = () => {
  const [isVisible, setIsVisible] = useState(false);
  const [confirmCallback, setConfirmCallback] = useState(null);
  const [modalProps, setModalProps] = useState({});

  // 패스워드 확인 모달을 보여주는 함수
  const showPasswordConfirm = (callback, options = {}) => {
    return new Promise((resolve, reject) => {
      setConfirmCallback(() => callback);
      setModalProps(options);
      setIsVisible(true);
      
      // Promise 버전도 지원
      if (!callback) {
        setConfirmCallback(() => resolve);
      }
    });
  };

  // 패스워드 확인 성공 시 호출
  const handleConfirm = () => {
    if (confirmCallback) {
      confirmCallback();
    }
    setIsVisible(false);
    setConfirmCallback(null);
    setModalProps({});
  };

  // 패스워드 확인 취소 시 호출
  const handleCancel = () => {
    setIsVisible(false);
    setConfirmCallback(null);
    setModalProps({});
  };

  return {
    isVisible,
    modalProps,
    showPasswordConfirm,
    handleConfirm,
    handleCancel
  };
};

export default usePasswordConfirm; 